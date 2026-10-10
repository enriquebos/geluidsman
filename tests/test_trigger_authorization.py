from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import pytest

from app.actions import EVENTS
from app.conversation_audio import Speech
from app.db import Database
from tests.test_actions import engine, event, rule
from tests.test_conversation import manager, seed

if TYPE_CHECKING:
    from pathlib import Path


def participant_setup(bot: object) -> tuple:
    creator = bot.voice.channel.members[0]
    participant = SimpleNamespace(id=200, bot=False)
    bot.voice.channel.members = [participant]
    bot.client.get_guild.return_value.get_member.side_effect = lambda identity: (
        creator if identity == 100 else participant
    )
    return creator, participant


@pytest.mark.parametrize("kind", list(EVENTS))
@pytest.mark.parametrize("action", ["play", "stop_all"])
def test_actions_outside_creator_keeps_participant_eligibility(tmp_path: Path, kind: str, action: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        participant_setup(value.bot)
        value.db.execute(
            "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES ('300','uploader','Uploader',0,0)"
        )
        value.db.execute("UPDATE clips SET creator_id='300' WHERE id='sound'")
        value.db.execute(
            "UPDATE users SET permission_overrides=? WHERE id='100'",
            ('{"view_actions":true,"play_outside_voice":false,"edit_all_sounds":false}',),
        )
        saved = rule(value, event=kind, action=action, clip_id="sound" if action == "play" else "", delay=0.01)
        if kind == "leave":
            value.bot.voice.channel.members = []
        assert not value.playback.permitted("100", ("play_outside_voice",))
        await value.run(saved, event(value, actor="200", kind=kind))
        assert value.db.one("SELECT outcome FROM audit WHERE action='action_trigger.fire'")["outcome"] == "success"
        if action == "play":
            value.bot.state.play.assert_called_once()
        else:
            value.bot.state.mixer.stop.assert_called_once()
        await value.close()
        value.db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "failure",
    ["participant_left", "participant_access", "creator_access", "guild_membership", "bot", "permission", "move"],
)
@pytest.mark.parametrize("kind", ["camera_on", "leave"])
def test_delayed_actions_recheck_participants_and_creator(tmp_path: Path, failure: str, kind: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        creator, participant = participant_setup(value.bot)
        saved = rule(value, event=kind, delay=0.02)
        item = event(value, actor="200", kind=kind)
        task = asyncio.create_task(value.run(saved, item))
        await asyncio.sleep(0)
        if failure == "participant_left":
            value.bot.voice.channel.members = []
        elif failure in {"participant_access", "creator_access"}:
            denied = participant if failure == "participant_access" else creator
            value.bot.voice.channel.permissions_for.side_effect = lambda member: SimpleNamespace(
                view_channel=member is not denied, connect=member is not denied
            )
        elif failure == "guild_membership":
            value.bot.client.get_guild.return_value.get_member.side_effect = lambda identity: (
                creator if identity == 100 else None
            )
            value.bot.client.get_guild.return_value.fetch_member = AsyncMock(return_value=None)
        elif failure == "bot":
            participant.bot = True
        elif failure == "permission":
            value.db.execute(
                "UPDATE users SET permission_overrides=? WHERE id='100'",
                (json.dumps({"view_actions": True, "play_sounds": False}),),
            )
        else:
            value.bot.voice.channel.id = 456
        await task
        succeeds = failure == "participant_left" and kind == "leave"
        assert bool(value.bot.state.play.call_count) is succeeds
        assert value.db.one("SELECT outcome FROM audit WHERE action='action_trigger.fire'")["outcome"] == (
            "success" if succeeds else "rejected"
        )
        await value.close()
        value.db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["", "participant_left", "participant_access", "permission", "disabled"])
@pytest.mark.parametrize("delay", [0, 0.02])
def test_conversation_outside_creator_and_eligibility(tmp_path: Path, failure: str, delay: float) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "conversation.sqlite3")
        seed(db)
        db.execute(
            "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES ('300','uploader','Uploader',0,0)"
        )
        db.execute("UPDATE clips SET creator_id='300' WHERE id='sound'")
        db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_outside_voice":false}',))
        value = manager(db)
        _, participant = participant_setup(value.bot)
        await value.synchronize()
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,"
            "cooldown,enabled,created_at,delay)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("trigger", "100", "sound", "hello", "word", "everyone", "[]", 0, 1, 0, delay),
        )
        saved = db.one("SELECT * FROM conversation_triggers")
        speech = Speech("200", "Participant", None, time.time(), time.time(), b"audio")
        task = asyncio.create_task(
            value.fire_delayed(saved, value.session["id"], speech)
            if delay
            else value.fire(saved, value.session["id"], speech)
        )
        await asyncio.sleep(0)
        if failure == "participant_left":
            value.bot.voice.channel.members = []
        elif failure == "participant_access":
            value.bot.voice.channel.permissions_for.side_effect = lambda member: SimpleNamespace(
                view_channel=member is not participant, connect=True
            )
        elif failure == "permission":
            db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_sounds":false}',))
        elif failure == "disabled":
            db.execute("UPDATE conversation_triggers SET enabled=0")
        await task
        assert bool(value.bot.state.play.call_count) is (not failure)
        await value.close_session()
        db.close()

    asyncio.run(scenario())
