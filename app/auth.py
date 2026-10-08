from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
import time
from typing import TYPE_CHECKING, Annotated
from urllib.parse import urlencode, urlsplit

import aiohttp
import discord
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse

from app.permissions import effective_permissions

if TYPE_CHECKING:
    from fastapi import FastAPI

    from app.bot import Bot
    from app.config import Settings
    from app.db import Database

SESSION_SECONDS = 30 * 86400
IDLE_SECONDS = 7 * 86400
CHECK_SECONDS = 300
SESSION_TOUCH_SECONDS = 60
STATE_SECONDS = 600
GUILD_PAGE_SIZE = 200
MAX_PENDING_LOGINS = 1000
ASCII_CONTROL_BOUNDARY = 32
DISCORD_API = "https://discord.com/api/v10"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def internal_path(value: str) -> str:
    if any(ord(character) < ASCII_CONTROL_BOUNDARY for character in value):
        return "/soundboard"
    parsed = urlsplit(value)
    if parsed.scheme or parsed.netloc or not value.startswith("/") or value.startswith("//") or "\\" in value:
        return "/soundboard"
    return value


class Auth:
    def __init__(self, settings: Settings, db: Database, bot: Bot) -> None:
        self.settings, self.db, self.bot = settings, db, bot
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20))
        self.locks: dict[str, asyncio.Lock] = {}
        self.members: dict[tuple[str, str], tuple[float, discord.Member]] = {}
        self.cipher = None
        self.admin_ids = set(settings.app_admin_ids)
        self.cleanup_task = asyncio.create_task(self.cleanup())
        try:
            if settings.auth_encryption_key.get_secret_value():
                self.cipher = Fernet(settings.auth_encryption_key.get_secret_value().encode())
        except (ValueError, TypeError):
            self.cipher = None

    @property
    def configured(self) -> bool:
        return bool(self.cipher and self.settings.discord_client_secret.get_secret_value())

    @property
    def callback(self) -> str:
        return self.settings.app_base_url.rstrip("/") + "/api/auth/discord/callback"

    def cookie(self, response: RedirectResponse, key: str, value: str, age: int) -> None:
        response.set_cookie(
            key,
            value,
            max_age=age,
            httponly=True,
            secure=self.settings.app_base_url.startswith("https://"),
            samesite="lax",
            path="/",
        )

    async def cleanup(self) -> None:
        while True:
            now = time.time()
            self.db.execute("DELETE FROM sessions WHERE expires_at<? OR last_seen<?", (now, now - IDLE_SECONDS))
            self.db.execute("DELETE FROM oauth_states WHERE expires_at<?", (now,))
            retention = self.db.setting("app_settings", {}).get("audit_retention_days", 90)
            self.db.execute("DELETE FROM audit WHERE timestamp<?", (now - retention * 86400,))
            self.locks = {key: lock for key, lock in self.locks.items() if lock.locked()}
            self.members = {key: value for key, value in self.members.items() if value[0] > now - CHECK_SECONDS}
            await asyncio.sleep(60)

    async def close(self) -> None:
        self.cleanup_task.cancel()
        await asyncio.gather(self.cleanup_task, return_exceptions=True)
        await self.http.close()

    async def discord_request(
        self, method: str, path: str, token: str | None = None, data: dict | None = None
    ) -> dict | list:
        headers = {"Authorization": "Bearer " + token} if token else {}
        try:
            async with self.http.request(
                method,
                ("https://discord.com/api/oauth2/token" if path == "/oauth2/token" else DISCORD_API + path),
                headers=headers,
                data=data,
            ) as response:
                logging.getLogger("app.discord").info(
                    "Discord %s %s: HTTP %s", method, urlsplit(path).path, response.status
                )
                if response.status == status.HTTP_429_TOO_MANY_REQUESTS:
                    raise HTTPException(503, "Discord rate-limited this request. Wait a few minutes before retrying.")
                if response.status >= status.HTTP_500_INTERNAL_SERVER_ERROR:
                    raise HTTPException(503, "Discord returned a server error. Try again shortly.")
                if response.status in (401, 403, 404):
                    raise HTTPException(403, "Discord access was revoked or this server is unavailable.")
                if response.status >= status.HTTP_400_BAD_REQUEST:
                    raise HTTPException(400, "Discord could not complete login. Please try again.")
                return await response.json()
        except (aiohttp.ClientError, TimeoutError) as error:
            logging.getLogger("app.discord").exception("Discord request failed: %s %s", method, urlsplit(path).path)
            raise HTTPException(503, "Could not reach Discord. Check the connection and try again shortly.") from error

    async def exchange(self, values: dict) -> dict:
        return await self.discord_request(
            "POST",
            "/oauth2/token",
            data={
                **values,
                "client_id": str(self.settings.discord_application_id),
                "client_secret": self.settings.discord_client_secret.get_secret_value(),
            },
        )

    def seal(self, credentials: dict) -> str:
        if not self.cipher:
            raise HTTPException(503, "Discord login is not configured.")
        return self.cipher.encrypt(json.dumps(credentials).encode()).decode()

    def unseal(self, credentials: str) -> dict:
        try:
            if not self.cipher:
                raise HTTPException(503, "Discord login is not configured.")
            return json.loads(self.cipher.decrypt(credentials.encode()))
        except (InvalidToken, ValueError) as error:
            raise HTTPException(401, "Please sign in again.") from error

    async def shared_guilds(self, token: str) -> list[dict]:
        if not self.bot.client.is_ready():
            raise HTTPException(503, "The bot is reconnecting. Try login again shortly.")
        shared = []
        after = "0"
        while True:
            page = await self.discord_request(
                "GET", "/users/@me/guilds?" + urlencode({"limit": GUILD_PAGE_SIZE, "after": after}), token
            )
            known = {
                str(guild.id): guild for guild in self.bot.client.guilds if guild.id == self.settings.discord_guild_id
            }
            shared.extend({"id": item["id"], "name": known[item["id"]].name} for item in page if item["id"] in known)
            if len(page) < GUILD_PAGE_SIZE:
                break
            after = page[-1]["id"]
        return shared

    async def begin(self, destination: str) -> RedirectResponse:
        if not self.configured:
            raise HTTPException(503, "Discord login is not configured.")
        state, browser = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.db.execute("DELETE FROM oauth_states WHERE expires_at<?", (time.time(),))
        self.db.execute(
            "INSERT INTO oauth_states VALUES (?,?,?,?)",
            (digest(state), digest(browser), internal_path(destination), time.time() + STATE_SECONDS),
        )
        params = {
            "client_id": str(self.settings.discord_application_id),
            "response_type": "code",
            "redirect_uri": self.callback,
            "scope": "identify guilds guilds.members.read",
            "state": state,
        }
        response = RedirectResponse("https://discord.com/oauth2/authorize?" + urlencode(params), status_code=302)
        self.cookie(response, "oauth_browser", browser, STATE_SECONDS)
        return response

    async def complete(self, request: Request) -> RedirectResponse:
        state_id = digest(request.query_params.get("state", ""))
        with self.db.lock, self.db.conn:
            state = self.db.one("SELECT * FROM oauth_states WHERE id=?", (state_id,))
            self.db.conn.execute("DELETE FROM oauth_states WHERE id=?", (state_id,))
        if (
            not state
            or state["expires_at"] < time.time()
            or not secrets.compare_digest(state["browser"], digest(request.cookies.get("oauth_browser", "")))
        ):
            raise HTTPException(400, "Login expired or could not be verified. Start login again.")
        if request.query_params.get("error") or not request.query_params.get("code"):
            return RedirectResponse("/login?error=cancelled", status_code=302)
        try:
            credentials = await self.exchange(
                {
                    "grant_type": "authorization_code",
                    "code": request.query_params["code"],
                    "redirect_uri": self.callback,
                }
            )
            credentials["expires_at"] = time.time() + credentials["expires_in"]
            profile = await self.discord_request("GET", "/users/@me", credentials["access_token"])
            guilds = await self.shared_guilds(credentials["access_token"])
            if not guilds:
                return RedirectResponse("/login?error=ineligible", status_code=302)
            now = time.time()
            avatar = profile.get("avatar")
            avatar_url = f"https://cdn.discordapp.com/avatars/{profile['id']}/{avatar}.png" if avatar else None
            session_id, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            with self.db.lock, self.db.conn:
                self.db.conn.execute(
                    "INSERT INTO users(id,username,display_name,avatar,created_at,last_login) VALUES (?,?,?,?,?,?) "
                    "ON CONFLICT(id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name,"
                    "avatar=excluded.avatar,last_login=excluded.last_login",
                    (
                        profile["id"],
                        profile["username"],
                        profile.get("global_name") or profile["username"],
                        avatar_url,
                        now,
                        now,
                    ),
                )
                self.db.conn.execute(
                    "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
                    (
                        digest(session_id),
                        profile["id"],
                        csrf,
                        self.seal(credentials),
                        now + SESSION_SECONDS,
                        now,
                        now,
                        json.dumps(guilds),
                    ),
                )
            old = request.cookies.get("session")
            if old:
                self.db.execute("DELETE FROM sessions WHERE id=?", (digest(old),))
            response = RedirectResponse(state["destination"], status_code=302)
            self.cookie(response, "session", session_id, SESSION_SECONDS)
            response.delete_cookie("oauth_browser", path="/")
        except HTTPException as error:
            if error.status_code == status.HTTP_503_SERVICE_UNAVAILABLE:
                return RedirectResponse("/login?error=unavailable", status_code=302)
            return RedirectResponse("/login?error=failed", status_code=302)
        else:
            return response

    async def token(self, session: dict) -> str:
        credentials = self.unseal(session["credentials"])
        if credentials["expires_at"] <= time.time() + 60:
            try:
                credentials = await self.exchange(
                    {"grant_type": "refresh_token", "refresh_token": credentials["refresh_token"]}
                )
            except HTTPException as error:
                if error.status_code != status.HTTP_503_SERVICE_UNAVAILABLE:
                    self.db.execute("DELETE FROM sessions WHERE id=?", (session["id"],))
                    raise HTTPException(401, "Please sign in again.") from error
                raise
            credentials["expires_at"] = time.time() + credentials["expires_in"]
            session["credentials"] = self.seal(credentials)
            self.db.execute("UPDATE sessions SET credentials=? WHERE id=?", (session["credentials"], session["id"]))
        return credentials["access_token"]

    def touch_session(self, session: dict, now: float) -> None:
        if session["last_seen"] < now - SESSION_TOUCH_SECONDS:
            self.db.execute("UPDATE sessions SET last_seen=? WHERE id=?", (now, session["id"]))

    async def current(self, request: Request, *, csrf: bool = True) -> dict:
        if not self.configured:
            raise HTTPException(503, "Discord login is not configured.")
        session_id = digest(request.cookies.get("session", ""))
        if not self.db.one("SELECT id FROM sessions WHERE id=?", (session_id,)):
            raise HTTPException(401, "Sign in with Discord to continue.")
        lock = self.locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            session = self.db.one("SELECT * FROM sessions WHERE id=?", (session_id,))
            now = time.time()
            if not session or session["expires_at"] < now or session["last_seen"] < now - IDLE_SECONDS:
                self.db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
                raise HTTPException(401, "Sign in with Discord to continue.")
            if csrf and request.method not in ("GET", "HEAD", "OPTIONS"):
                origin = request.headers.get("origin")
                if origin != self.settings.app_base_url.rstrip("/") or not secrets.compare_digest(
                    request.headers.get("x-csrf-token", ""), session["csrf"]
                ):
                    raise HTTPException(403, "This request could not be verified. Reload and try again.")
            if session["checked_at"] < now - CHECK_SECONDS or not any(
                item["id"] == str(self.settings.discord_guild_id) for item in json.loads(session["guilds"])
            ):
                try:
                    guilds = await self.shared_guilds(await self.token(session))
                except HTTPException as error:
                    if error.status_code == status.HTTP_403_FORBIDDEN:
                        self.db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
                        raise HTTPException(401, "Please sign in again.") from error
                    raise
                if not guilds:
                    self.db.execute("DELETE FROM sessions WHERE user_id=?", (session["user_id"],))
                    raise HTTPException(403, "You must be a member of the configured Discord server.")
                session["guilds"] = json.dumps(guilds)
                self.db.execute(
                    "UPDATE sessions SET checked_at=?,guilds=? WHERE id=?", (now, session["guilds"], session_id)
                )
            self.touch_session(session, now)
            user = self.db.one("SELECT * FROM users WHERE id=?", (session["user_id"],))
            user["admin"] = user["id"] in self.admin_ids
            user["permissions"] = effective_permissions(
                json.loads(user.pop("permission_overrides")), admin=user["admin"]
            )
            user["preferences"] = {
                "preview_volume": 0.8,
                "caption_language": "all",
                "soundboard_mode": "default",
                **json.loads(user["preferences"]),
            }
            user["preferences"].pop("default_guild_id", None)
            user["guilds"] = [
                item for item in json.loads(session["guilds"]) if item["id"] == str(self.settings.discord_guild_id)
            ]
            user["csrf"] = session["csrf"]
            request.state.user, request.state.session = user, session
            return user

    async def member(
        self, request: Request, guild_id: str, *, fresh: bool = True, max_age: float = CHECK_SECONDS
    ) -> discord.Member:
        if guild_id != str(self.settings.discord_guild_id):
            raise HTTPException(403, "This app only supports the configured Discord server.")
        if not self.bot.client.is_ready():
            raise HTTPException(503, "The bot is reconnecting. Try again shortly.")
        guild = self.bot.client.get_guild(int(guild_id))
        if not guild:
            raise HTTPException(403, "You and the bot must belong to this server.")
        session = request.state.session
        key = (session["id"], guild_id)
        async with self.locks.setdefault(session["id"], asyncio.Lock()):
            cached = self.members.get(key)
            if not fresh and cached and cached[0] > time.time() - max_age:
                return cached[1]
            try:
                member = await asyncio.wait_for(guild.fetch_member(int(session["user_id"])), 20)
            except discord.NotFound as error:
                self.members.pop(key, None)
                raise HTTPException(403, "You must be a member of the configured Discord server.") from error
            except (discord.HTTPException, TimeoutError, aiohttp.ClientError, OSError) as error:
                logging.getLogger("app.discord").exception("Could not verify server membership using the bot")
                raise HTTPException(503, "The bot could not verify server membership. Try again shortly.") from error
            self.members[key] = (time.time(), member)
            return member


async def authorize(request: Request) -> dict:
    return await request.app.state.auth.current(request)


async def authorize_admin(request: Request) -> dict:
    user = await authorize(request)
    if not user["admin"]:
        raise HTTPException(403, "App administrator access is required.")
    return user


def register_auth_routes(app: FastAPI) -> None:
    @app.get("/api/auth/discord/login")
    async def login(destination: Annotated[str, Query(alias="next")] = "/soundboard") -> RedirectResponse:
        return await app.state.auth.begin(destination)

    @app.get("/api/auth/discord/callback")
    async def callback(request: Request) -> RedirectResponse:
        return await app.state.auth.complete(request)

    @app.get("/api/auth/me")
    async def me(request: Request) -> dict:
        return await authorize(request)

    @app.post("/api/auth/logout")
    @app.post("/api/auth/logout-all")
    async def logout(request: Request) -> RedirectResponse:
        await app.state.auth.current(request, csrf=True)
        if request.url.path.endswith("logout-all"):
            app.state.db.execute("DELETE FROM sessions WHERE user_id=?", (request.state.user["id"],))
        else:
            app.state.db.execute("DELETE FROM sessions WHERE id=?", (request.state.session["id"],))
        response = RedirectResponse("/login", status_code=303)
        response.delete_cookie("session", path="/")
        return response
