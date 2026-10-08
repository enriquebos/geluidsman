# Geluidsman

A shared Discord soundboard with a video library and a waveform clip editor.
Runs on your PC: discord.py with DAVE voice support, FastAPI, PostgreSQL, React,
TypeScript, WaveSurfer.js, yt-dlp, and FFmpeg.

## Get the source

```text
git clone https://github.com/enriquebos/geluidsman.git
cd geluidsman
```

Commit source, tests and dependency lockfiles. Local `.env` files, media,
databases, backups, dependency directories and generated builds stay outside Git.
Copy `.env.example` for a new installation and keep credentials private.
The emoji catalogue and its upstream license are included in the source tree.
Git normalizes text to LF so Windows and Linux checkouts produce consistent diffs.
GitHub Actions checks backend tests with PostgreSQL, Ruff, Poetry, the frontend
build and desktop/touch browser workflows using isolated fixtures.

## Docker Compose stack on Windows and Linux

Install Docker Desktop with Linux containers on Windows, or Docker Engine with
Compose v2 on Linux. No PowerShell scripts, host Python, Node, FFmpeg or Deno
installation is required. Run the following commands from the project root.

Create `.env` only when it does not exist. Windows Command Prompt:

```bat
if not exist .env copy .env.example .env
```

Linux:

```sh
test -f .env || cp .env.example .env
mkdir -p data
```

Fill in the bot/OAuth secrets, `AUTH_ENCRYPTION_KEY`, `APP_BASE_URL`, and a long
random `POSTGRES_PASSWORD` in `.env`. Use hexadecimal characters for the database
password because it is embedded in the internal connection URL. Keep existing
secrets when upgrading. On Linux set `APP_UID` and `APP_GID` to the owner of the
`data` directory (check `id -u` and `id -g`). Windows uses the default values.

```text
docker compose up -d --build --wait
docker compose logs -f app
```

Open **http://127.0.0.2:8687**, matching `APP_BASE_URL`. Ctrl+C exits the log
viewer; stop the stack with `docker compose stop`. Restart with
`docker compose up -d --wait`. After code or dependency updates, run
`docker compose up -d --build --wait`. Never run the old host process alongside
the container: there must be one app process and one Discord bot connection.

The custom multi-stage image builds React and installs locked Poetry dependencies
in separate cached layers. BuildKit caches npm and Poetry downloads. Code edits
reuse dependency layers; package manifest changes rebuild them. The final image
contains the built dashboard, Python runtime, FFmpeg/FFprobe, Deno and Opus, and
runs as a non-root user. Development dependencies and tests are separate stages.
PostgreSQL 17 runs on the private Compose network without a published host port.
The app listens on container port 8687; `PORT` sets the published host port.
Changing that port also requires updating `APP_BASE_URL` and the Discord callback.

Media persists in host `data/media`; PostgreSQL persists in the named
`postgres_data` volume. `docker compose down` keeps both. **Do not use
`docker compose down -v` unless you intend to permanently delete the database.**
Health checks gate startup and the app receives a graceful shutdown signal.
Unfinished channel queues remain persisted and can be resumed from the dashboard.
Voice is never automatically joined at startup.

Production uses PostgreSQL. SQLite is used only by isolated development fixtures.
Startup initializes the current schema and recovers interrupted imports; it does not
alter legacy schemas, backfill historical activity, or rewrite old voice settings.

The application is **1502044170406199416**, restricted to server
**1352422295402057759**. The bot needs View Channel, Connect and Speak. The token
is used only by the backend; the dashboard cannot read `.env`.

## Page URLs

The soundboard is `/soundboard`, the video library is `/videos`, and the waveform
editor is `/videos/{video_id}/cut`. These URLs work directly and survive reloads.
Back/Forward restores the selected page. Caption results can include `?t=seconds`
to preserve the initial preview position in a shared editor link. `/` opens the
soundboard. Missing video links show a return-to-library action.

## Use it

1. Pick a voice channel and click **Connect**.
2. Open **Video library**, paste a supported individual video URL, and import.
3. Click **Watch & cut**. Video playback and waveform position stay synchronized.
4. Drag the start/end handles. Keep dragging slowly (under 80 px/s) or pause for 0.5 seconds for 4× precision
   zoom, which stays active until release. Drag the selected region to move the entire
   cut while preserving its length. Release returns to
   the previous zoom. The scrollbar stays hidden. Mouse, touch, numeric timestamps, and arrow-key
   adjustments are supported (Shift+arrow adjusts by one second).
5. Preview the cut (Space starts at the selection start; Space again pauses), name
   it, optionally choose an emoji with the searchable picker or paste one, set tags/volume, and save.
6. Click **Play sound** to send it to Discord. **Preview** plays only in your browser.

Up to eight sounds can overlap, including multiple instances of the same sound.
Stop each instance from the playback bar, or use **Stop all**. Disconnecting or
changing channels stops all sounds. Master volume affects Discord playback;
clip volume is saved separately. Browser previews cap gain at 100%.
Sound names allow up to 255 characters. Tags appear as removable chips: choose
an existing tag or type a new one and press Enter (up to 10 tags, 30 characters
each). The emoji picker supports search; emojis can also be pasted. The Server category
automatically lists available custom emojis from the configured Discord server,
including animated emojis. Images load from Discord's CDN; deleted emoji images
fall back to their names. Server emoji changes refresh connected dashboards.

Edit a saved sound's metadata from its `…` button. To change its trim, create a
new clip from the retained source. Delete a source's clips before deleting the
source. Deletion is permanent and requires a dashboard confirmation.

## Import a YouTube channel

Paste a channel URL such as `https://www.youtube.com/@KudNL/videos` into the
Video URL field. The button changes to **Import channel**. Public videos from
the Videos tab are discovered and queued, then downloaded one at a time with
captions and the usual duration/size/storage checks. Shorts and live tabs are
not included. Existing YouTube videos are skipped, including alternate share URLs.
Unavailable videos are reported individually while the remaining queue continues.

The batch panel shows imported, skipped, failed, and queued counts. **Pause channel**
stops the current download safely; **Resume channel** continues unfinished items.
**Retry failed videos** retries failures without redownloading completed items.
Queue progress is stored in PostgreSQL. After restart, unfinished channel batches are
paused and can be resumed. Import the channel again to discover new uploads.
`MAX_CHANNEL_VIDEOS` defaults to 2000; larger channels are rejected without silently
truncating the batch. The existing 10 GB storage limit still applies.

## Find speech with captions

Imports also fetch Dutch and English captions, preferring manual tracks and falling
back to automatic tracks when available. Search **Find the words** across the library
or inside **Watch & cut**, with Dutch/English filters. Select a result to seek the
video and waveform without playing; **Use for clip** sets the trim selection.
Word timing is used only where captions supply it; otherwise results use caption-line
timing and the waveform lets you refine the cut. No transcription model is used.

Existing videos can be refreshed through the source-refresh API to fetch captions. Refresh keeps the library ID
and saved sounds, downloads into a new revision, and switches only after processing
succeeds. Failed/interrupted refreshes preserve the original. Missing or failed
caption tracks are visible without discarding the video. Each caption file is
limited to 8 MB and 100,000 cues, within the existing import/storage budget.

## Discord login and access

All library, media, playback and audit APIs require login. Accounts are created
only after Discord confirms that the user belongs to De Mannen (`1352422295402057759`). The
library and audit log are shared across eligible users; everyone can edit and
delete shared content. Voice control additionally requires current membership
and View Channel/Connect permission in the target server. The bot needs
View Channel, Connect and Speak. Members need not be in voice themselves.

For this installation, open **http://127.0.0.2:8687** consistently. Set
`APP_BASE_URL` to that exact origin and register
`http://127.0.0.2:8687/api/auth/discord/callback` under OAuth2 → Redirects in
Discord application `1502044170406199416`. Login requests the `identify`,
`guilds`, and `guilds.members.read` scopes. It never requests email, reads
messages, or operates a user account as a bot. Leave Public Client disabled.

Keep `DISCORD_TOKEN`, `DISCORD_CLIENT_SECRET`, and `AUTH_ENCRYPTION_KEY` in
`.env`. After building the app image, generate the encryption key once with:

```text
docker compose run --rm --no-deps app python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Copy the generated value into `.env`; do not commit it. Missing configuration
blocks access. OAuth tokens are encrypted in PostgreSQL and never sent to the
frontend; opaque session cookie IDs are stored as hashes. Cookies are HttpOnly
and SameSite=Lax; HTTPS enables Secure. Modifications require a CSRF token and
matching Origin. Sessions last at most 30 days and expire after seven idle days.
Eligibility is rechecked within five minutes, and every voice mutation checks
current target-server membership through the normal bot API and checks channel permissions.
Dashboard membership reads share a five-minute cache; playback does not call the rate-limited OAuth membership endpoint. Discord outages fail closed
without deleting account history.

Users with the **Access admin panel** permission can access `/admin`.
`APP_ADMIN_IDS=["DISCORD_USER_ID"]` defines protected administrators whose
admin access cannot be disabled. Server owners/admins do not automatically
become app admins, and app admins must also satisfy configured-server eligibility.

`/settings` includes profile, personal preview volume, caption language, logout and logout-all. `/admin` contains application settings and a live console of sanitized website/bot logs. The console keeps up to 2,000 entries in memory until restart; error entries include stack traces. App admins can change import
limits, storage limits and audit retention. These database overrides apply to new
operations; running imports retain their snapshot of limits. `.env` supplies
defaults for settings without an override. Eight simultaneous sounds are
supported in the configured server with one connection and master volume.

The admin console stays above the **Settings** and **Permissions** tabs. Use
`/admin?tab=settings` or `/admin?tab=permissions`; the selected tab survives
reload and browser navigation without resetting the console. Permissions lists
registered users with search and 50-user pagination. Select a user; permission switches update immediately, or reset them to defaults. Configured `.env` admins start with full access. Only the protected user can change
their own other permissions for testing; admin access remains locked on. Reset
restores their full access. Other administrators cannot modify protected accounts.
Admin panel access does not bypass other permissions.

Permissions cover playing/stopping sounds, voice connection/disconnection,
master volume, mute/deafen, creating/editing/deleting sounds, video/channel
imports, import-job management, video deletion, and audit access. Defaults allow
everything except admin access, boosted sound volume, master volume and mute/deafen. Edit/delete all includes the user's own sounds;
unattributed legacy sounds require the corresponding all-sounds permission.
Retrying an import also requires its import permission; resuming a channel
requires channel import and job management. Browser previews, browsing,
personal favourites and personal settings remain available to signed-in users.

Permission overrides are stored separately from preferences in PostgreSQL. The API reads permissions on every authenticated request,
so changes affect existing sessions immediately; denials return 403 without
logging users out. Connected dashboards refresh their available controls.
Granting mute/deafen never grants access to the admin page. Permission saves
and resets appear in the audit log with the actor, target and changed values.

`/audit` shows actor, action, time, outcome and resource, with filters
and pagination. Browser previews are not Discord play events. Playback success
means accepted by the bot mixer, not a guarantee somebody heard it. Historical
sounds retain Unknown creator; attribution starts with this version. Audit
entries keep names after deletion, with a default 90-day retention, configurable
from 1 to 3650 days. Cleanup runs each minute; there is no per-entry deletion UI.

## Access from the internet

The service listens on **0.0.0.0:8687**. Login is initially configured for the
local origin above. Before public login, provide HTTPS, set `APP_BASE_URL` to
its exact public origin and register its `/api/auth/discord/callback` redirect
in Discord. Do not expose authenticated session cookies over public plain HTTP.
TLS hosting and router changes are manual; no TLS proxy is bundled with the app.
If you use port forwarding, reserve this PC's LAN address, allow the relevant
inbound port in Windows Firewall or your Linux firewall, and forward that port to the TLS endpoint.
CGNAT may require a public IP from your ISP. Keep `.env` private.

## Limits and storage

`.env.example` documents every setting. Defaults:

| Setting | Default |
| --- | --- |
| `PORT` | 8687 |
| `MAX_SOURCE_SECONDS` | 3600 |
| `MAX_IMPORT_BYTES` | 1,000,000,000 |
| `MAX_STORAGE_BYTES` | 10,000,000,000 |
| `MAX_CLIP_SECONDS` | 60 |
| `MAX_PLAYBACKS` | 8 |
| `IMPORT_TIMEOUT_SECONDS` | 1800 |
| `JS_RUNTIME` | deno |

One import runs at a time. URLs must use HTTP(S) on port 80/443. A download-only
forwarding proxy validates and pins public IPs for every connection, including
redirects and CDN segments. Other protocols, embedded credentials, local/private
addresses, general playlists, unknown-duration media, and live streams are rejected.
Explicit YouTube channel batches discover public videos before importing each one.
Native yt-dlp downloaders use the proxy; FFmpeg processes local media only.
The import byte budget includes upstream protocol traffic as well as media,
and final processed media is checked against the same limit. Files are stored
under generated IDs, without exposing signed CDN links in job errors.

Public source availability can change. Some sites require sign-in or block
downloads; this version does not load browser cookies or support DRM.
Use only sources you have permission to download. Keep yt-dlp current:

```text
poetry update yt-dlp
```

Metadata is stored in PostgreSQL; media is in `data/media/`. Startup marks
unfinished jobs interrupted and removes unreferenced media revisions. Interrupted
sounds are never replayed and voice connections require an explicit action.

### Backup and restore

Stop the app while backing up both the database and media:

```text
docker compose stop app
docker compose exec -T db pg_dump -U geluidsman -d geluidsman -Fc -f /tmp/library.dump
docker compose cp db:/tmp/library.dump library.dump
```

Copy `data` and `.env` to private backup storage, then restart with
`docker compose up -d --wait app`. The
commands use the default database/user names; adjust them if configured differently.
Compose copy preserves binary backups on both Windows and Linux.

To restore, stop the app, restore the matching `data` and `.env`, copy the dump
with `docker compose cp library.dump db:/tmp/library.dump`, then run
`docker compose exec -T db pg_restore -U geluidsman -d geluidsman --clean --if-exists /tmp/library.dump`.
This replaces existing database content. Start the app only after all parts are
restored. The original encryption key is needed to decrypt saved OAuth credentials.

## API and development

`GET /api/state` returns the library, jobs, voice status, available channels, and
limits. `GET /api/events` is the server-sent event stream. IDs are generated
strings; Discord snowflakes are returned as strings to preserve precision.

| Operation | Endpoint |
| --- | --- |
| Permission catalogue | `GET /api/admin/permissions` (admin only) |
| Registered users | `GET /api/admin/users?q=search&page=1&page_size=50` (admin only) |
| Replace permission overrides | `PUT /api/admin/users/{id}/permissions` with `{ "overrides": { "play_sounds": false } }` (admin only) |
| Reset permission defaults | `DELETE /api/admin/users/{id}/permissions` (admin only) |
| Import | `POST /api/imports` with `{ "url": "https://…" }` |
| Caption search | `GET /api/captions/search?q=words&language=all` with optional `source_id`, `offset`, `limit` (1–50) |
| Redownload | `POST /api/sources/{id}/refresh`, returns `job_id` |
| Dismiss import error | `DELETE /api/imports/{job_id}` (finished jobs only) |
| Channel import | `POST /api/channel-imports` with `url`, returns `batch_id` |
| Pause / resume channel | `POST /api/channel-imports/{batch_id}/pause` or `/resume` |
| Retry | `POST /api/imports/{job_id}/retry` |
| Extract | `POST /api/clips` with `source_id`, `start`, `end`, `name`, optional `emoji`, `tags`, `volume` |
| Edit / delete | `PATCH` / `DELETE /api/clips/{id}` |
| Delete source | `DELETE /api/sources/{id}` |
| Connect / move | `POST /api/guilds/{guild_id}/voice/connect` with `{ "channel_id": "…" }` |
| Disconnect | `POST /api/guilds/{guild_id}/voice/disconnect` |
| Master volume | `PUT /api/guilds/{guild_id}/voice/volume` with `{ "volume": 0.8 }` |
| Play | `POST /api/clips/{id}/play`, returns `instance_id` |
| Stop instance | `DELETE /api/guilds/{guild_id}/playbacks/{instance_id}` |
| Stop all | `POST /api/guilds/{guild_id}/playbacks/stop` |

For native development install Poetry, Python, Node, FFmpeg, Deno and Opus,
then start `poetry run python -m app` and run `npm run dev` inside `frontend`.
Set `DATABASE_URL` to a development PostgreSQL instance; omit it only for isolated
SQLite fixtures.
The Vite development server proxies `/api` to the backend; production uses the
bundled frontend on the same origin. UI fonts fall back to system sans-serif if
Google Fonts is unavailable.

```text
poetry install --only main,dev
poetry run pytest
poetry run ruff check app tests
poetry run ruff format --check app tests
cd frontend
npm ci
npm run build
npx playwright install chromium
npm test
```

Browser tests use an isolated fixture service on localhost:8001 without your
Discord token or real library. Real Discord voice validation requires a chosen
channel and cannot be simulated by those tests.

Strict Ruff enables all rules with focused compatibility exceptions: docstrings and copyright headers are omitted, formatter-conflicting rules are disabled, HTTP handler naming/public binding follow their APIs, retained WAV readers use ExitStack ownership, and tests allow assertions and fixtures. Authored code contains no comments or docstrings.

## Authentication backup and maintenance

Use the PostgreSQL backup procedure above and preserve matching media and `.env`.
The database contains profiles, encrypted OAuth credentials, attribution and
audit history. The encryption key in `.env` is required to restore sessions.
Losing or replacing it requires users to log in again; content and attribution
remain intact. Never include `.env`, session cookies, credentials, or callback
codes in diagnostics. Uvicorn access logs remain disabled so callback codes
are not logged. Revoke grants from Discord's Authorized Apps when needed.

A pre-authentication SQLite backup was created under `.runtime/backups` during
this installation. Schema additions preserve existing sources and clips. Do
not restore an older schema while this server is running. Tests use explicit
isolated fixture identities; production has no anonymous/test-auth fallback.

Strict Ruff's additional focused exceptions cover fixed audit/query field
interfaces (`PLR0913` in database/accounts modules) and Discord's member
construction state (`SLF001` in the OAuth module). No code comments or
docstrings are introduced.

Audit filters provide searchable user, sound/video and server selectors; saved
and deleted sounds retain their emoji and name in filter options. Admin import
size and total storage settings display decimal MB and GB (1 MB = 1,000,000
bytes; 1 GB = 1,000,000,000 bytes). Click a sound card to play in Discord; its
Preview button plays only in the browser.

During a deliberate maintenance restart, `docker compose run --rm --service-ports app python -m app --resume-channel BATCH_ID`
can resume a specific paused channel queue. Omit this option for normal startup;
interrupted queues stay paused until resumed. Existing completed items remain
saved and an interrupted download is retried. This does not reconnect voice.

Failed and interrupted imports are retained in the audit log, including source title/URL, import ID, failure reason and suggested next steps. Use **Details** in an import notice or audit row. Historical failures retain their recorded details; exact downloader diagnoses cannot be recovered if they were never recorded. New downloader failures report safe categories without exposing credentials or raw network diagnostics.

The collection is ordered by newest addition and shows 50 videos per page. The audit log uses separate pages and a Result filter. Ignore on an inactive channel import hides its alert and related job notices persistently while retaining audit history and saved media. The emoji picker includes searchable categories and pages without its own scrollbar.

The app is restricted to Discord server `1352422295402057759`. Other-server membership never grants access, and voice requests for other servers are rejected. Audit activity uses compact rows with action icons, avatars, summaries and details dialogs. The emoji picker uses default emoji variants.

Pin favourite sounds with the star on each sound card. Pins are personal, persist across restarts, and appear before other matching sounds. Configured admins and users granted the mute/deafen permission can control the bot self-mute and self-deafen state in the playback bar; browser previews are unaffected. Deafen is enabled by default.

The app has no requests-per-second throttling. Clip extractions wait for the media worker instead of being rejected at a pending-job threshold. Discord API limits remain enforced by Discord. Storage, import-size, duration, and simultaneous playback bounds remain resource limits.

Playback and voice actions reuse a per-session bot membership check for at most 15 seconds. Channel permissions and configured-server checks still run for every action; expired checks fetch fresh membership. Playback updates use a small status response instead of reloading the video library. Voice toggles update immediately while pending and roll back on failure; sound cards show pending feedback until the bot accepts playback.

Dashboard display statistics are cached for up to five seconds and computed in
worker threads. Import/extraction storage checks always scan fresh usage; the
cache never controls storage admission. Caption tracks, import titles and
channel progress use bounded query counts. Import-progress events update
`GET /api/jobs` without reloading the library. Playback refreshes coalesce event
bursts, and hidden tabs resume full synchronization when visible again.
The editor updates its text clock once per second while retaining precise
waveform and selection timing. Session activity timestamps persist at most once
per minute; effective user permissions still load on every authenticated request.
Temporary Discord authentication outages keep the event connection retrying
without logging out an otherwise valid session.


PostgreSQL integration tests run against an isolated database named
`geluidsman_test`. Create it once and run the Linux test image:

```text
docker compose exec -T db createdb -U geluidsman geluidsman_test
docker compose build test
docker compose run --rm test
```

The test service receives only the test database URL, never bot/OAuth credentials.
Tests refuse to clear a database with any other name. It is excluded from normal
stack startup. `docker compose build app` selects the production image.

The bot stays connected while idle. If Discord exhausts its own voice reconnects,
the app retries the requested channel with bounded backoff while the gateway is
online. Explicit Disconnect cancels retries. Channel moves update the retry target;
permissions are checked again before rejoining. Interrupted sounds are stopped and
never replayed. Restarting the app clears the reconnect target and does not join voice.


The audit page includes a user leaderboard for successful sound creations and
Discord playback requests, sortable by creations or plays, and a playback-count
bar graph. It defaults to today in the browser's timezone (hourly intervals), with
7-, 30- and 90-day views (daily intervals). Empty intervals show zero. Statistics
use retained audit history, preserve activity for deleted sounds, exclude failed
plays and other servers, and require the same audit-view permission. The top 50
users are shown for the selected ranking. Use Refresh statistics to update counts.
Browser previews do not count as Discord plays.

Voice connection attempts have no app-imposed deadline. While connected and idle,
the mixer continues sending silence to keep the UDP stream active. Explicit
Disconnect cancels a pending connection; only its cleanup confirmation has a
10-second bound. Discord protocol heartbeats still detect broken connections and
trigger reconnects. Deployments restart the app and therefore disconnect voice.
Sanitized bot and website diagnostics also appear in `docker compose logs app`.


## Conversation transcripts and sound triggers

Open `/conversation` to see live speech as chat bubbles, your own on the right and other speakers on the left. Users granted Access Conversation page can read history; this permission is off by default for ordinary users. The navigation item is hidden when access is denied, and direct API requests are also checked. Protected administrators keep their existing full-access defaults. The recording switch is shared and persists across restarts; recording is enabled by default but the app never joins a voice channel at startup. Connecting from Soundboard or Conversation starts transcription once the local model is ready. Recording status and included participants are visible on the Conversation page; the bot does not send transcript notices in voice-channel text chat. Disabling recording stops capture and triggers. Deafening the bot pauses recording until someone with voice-toggle permission undeafens it; changing channels or losing the voice connection ends the session.

Dutch and English speech is recognized locally with faster-whisper's multilingual large-v3-turbo model. Audio exists only in bounded memory buffers and is not saved. Finalized transcript text, speaker identities and timestamps are available only during the active conversation. Closing the session, disabling recording or restarting the app deletes them. There is no saved conversation history or retention setting. Transcript text and audio are excluded from logs and SSE payloads. Playback history records trigger and speaker IDs, with skipped-playback explanations.

The Compose transcription service uses its own image, NVIDIA CUDA FP16 inference and a persistent transcription_models volume. The default stack reserves an NVIDIA GPU; Windows requires Docker Desktop with WSL2 GPU support, and Linux requires NVIDIA Container Toolkit. Its HTTP interface has no published host port. The first start downloads the model; later starts reuse the volume. Run `docker compose up -d --build` for the full stack and `docker compose logs transcription` for worker startup diagnostics. `docker compose exec -T transcription python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"` reports model readiness. TRANSCRIPTION_URL is an internal worker address, not the dashboard URL. Linux and Windows use the same GPU stack. For machines without an NVIDIA GPU, use `docker compose -f compose.yaml -f compose.cpu.yaml up -d --build` to select CPU INT8 inference; use the same two Compose files for later stop or restart commands. Back up PostgreSQL for users, permissions, library data and triggers. The model volume can be recreated from its upstream download.

Create word-to-sound triggers below the chat. Choose whole-word/phrase or contains matching, select everyone, yourself or specific Discord speakers, and set a cooldown (five seconds by default; zero is supported). Matching is case-insensitive and runs only on finalized speech. Each matched utterance fires a trigger once. Users with Conversation access can view all shared triggers, including their creator and enabled status. Anyone with Conversation access and trigger-management permission can edit or toggle any trigger, while its original creator remains unchanged. Deletion is restricted to the creator or admins with the relevant permissions. Playback rechecks the creator's permissions and channel access, uses the existing mixer, and rejects full capacity instead of queuing stale sounds. The bot's incoming stream is excluded; human microphone echo and recognition mistakes can still activate triggers.

The receive extension is pinned to commit 78fcb434a3484f2abf54cf89e80e86b651e5c28d of discord-ext-voice-recv-dave. The receive integration uses Discord's normal bot connection and DAVE decryption, not a user account. Tests cover application capture, speaker separation, lifecycle and trigger behavior without joining Discord voice. A user-controlled live session is still required to validate encrypted audio reception in the actual server.


Soundboard audio uploads

Choose **Add a sound** on Soundboard to drop or select an `.ogg` or `.mp3` file, preview it, and set its name, emoji, tags and volume. Files must contain audio, last 0.1–60 seconds (or the configured clip limit), and be at most 20 MB, subject to import and total storage limits. Uploads use the create-sounds permission, retain creator attribution and audit history, and do not create video-library entries. Original uploads are discarded after conversion to playback and preview formats. Existing video clips remain unchanged.

Caption search accepts partial final words and near spellings, with exact matches first. Search begins after 100 ms of typing and keeps previous results visible while updating. Matching speech is highlighted and retains supplied word timestamps where available. PostgreSQL uses indexed full-text and trigram candidates before ordered phrase matching.

Conversation starts in Dutch to avoid misdetecting short Dutch utterances as English. Users with recording-control permission can select Dutch, English or automatic detection on the Conversation page; the shared selection persists across restarts. The same Discord connection controls are available on Soundboard and Conversation. Scrolling up in the admin console pauses Follow latest; enable it again to return to live logs.

Live transcripts finalize after approximately 400 ms of silence. Continuous speech is split into bounded five-second segments, then processed by the same Dutch-default large-v3-turbo model. Completed transcript events fetch live messages immediately without waiting for trigger-list refreshes. Shorter segments reduce waiting but can affect recognition at boundaries; actual latency also depends on inference throughput and transcription backlog.

The emoji picker uses Unicode Emoji 17.0 metadata from iamcal/emoji-data, pinned to commit 13ee711e222ea17fe537bfea953c687866f16411. The MIT license and dataset provenance are in frontend/src/data. It contains 1,878 standard emoji plus the configured server custom emoji, with left-side categories and alias search. Skin-tone variants remain excluded. Standard artwork depends on the browser and operating system. The catalog loads on demand.

Speech preprocessing filters 48 kHz audio before converting to 16 kHz and retains up to 200 ms of quiet lead-in per speaker to preserve word beginnings. Transcription uses beam size five for a wider decoding search, while keeping the multilingual large-v3-turbo model and Dutch default. These improvements cannot correct all microphone noise, overlapping speech or missing context.

Soundboard sections appear in this order: Pinned, Frequently used, Top sounds, All sounds. Sounds can appear in multiple sections; All sounds always contains the complete filtered collection. Frequently used shows up to 12 sounds ranked by your successful Discord plays; Top sounds shows up to 12 sounds ranked by successful server plays. Counts use retained audit history and exclude browser previews and rejected playback. Search and tags filter every section. Collapse choices are saved per user in this browser. Default and Compact modes are saved to your account; Default retains the detailed cards. Compact cards show preview on the left, pinning on the right, and Discord playback in the center. Right-click or Shift+F10 opens sound actions on either style; editing remains subject to ownership permissions.

Conversation triggers support Play sound or Stop all sounds, with a 0–60 second delay separate from cooldown. Delays run in a bounded set of 32 pending actions without blocking transcription. Ending a session cancels pending actions; editing, disabling or deleting a trigger prevents its pending action from firing. Creator permissions and active-channel access are checked at execution. Stop all requires stop-sounds permission and stops the shared mixer; browser previews are unaffected. Existing triggers keep immediate sound playback through additive action/delay columns. Conversation and trigger deletions use themed confirmation dialogs.

Conversation is labelled BETA. The transcription worker uses faster-whisper large-v3-turbo on the GPU with FP16, beam size five and Dutch by default. CPU fallback retains four threads and INT8. The model is cached in the existing persistent volume; the first load downloads the larger model. Actual Dutch microphone accuracy still requires a user-controlled live test.

Soundboard sections display sounds newest first by creation time. Frequently used
and Top sounds select their highest-ranked 20 sounds, then display that selection
newest first. Sound volume sliders always show 0–1000%; without the **Boost sound
volume to 1000%** permission they stop at 300%. The higher segment is visibly
restricted. Creation, upload and editing APIs enforce the same permission and
absolute 1000% limit. Browser previews still cap gain at 100%.

New cuts from the video editor always start at 100% volume. Adjust volume later
in the sound editor. Permission edits update the selected user locally without
refetching the user list; searching or changing pages still loads the matching users.


Finalized utterances wait at most 40 ms to collect a batch of up to four. The worker applies voice activity detection separately to each utterance and decodes independent audio regions together; speaker audio is never mixed. Automatic language mode detects each utterance separately and groups compatible languages. Queue and request bounds remain enforced, and session changes or stale results prevent transcript saving and trigger playback. The worker exposes `/transcribe/batch` only on the internal Compose network; its `/health` response reports readiness, requested device and maximum batch size without transcript content.

The GPU dependencies are locked in Poetry's optional `gpu` group and included only in the transcription image. CUDA/cuDNN libraries are supplied by the image; the host needs a compatible NVIDIA driver. The model cache and PostgreSQL data volumes remain unchanged. GPU initialization failures remain visible through worker health and the conversation status; the default stack does not silently fall back to CPU.


A local warmed-up benchmark on the Ryzen 7 9800X3D / RTX 5080 processed one five-second library sample in a median 2.810 seconds on the previous CPU INT8 worker and 0.187 seconds on GPU FP16. Four copies decoded together took 0.391 seconds per batch. These are inference/HTTP timings from three measured runs after warm-up, not end-to-end live-call latency or an accuracy benchmark. Finalization silence, batching wait, microphone quality, utterance length and system load still affect the user experience; batched decoding can produce different wording from individual decoding.


Conversation triggers accept up to 20 alternative words or phrases, each in a separate input with up to 255 characters. Use Add word or phrase to add an entry and its remove button to delete it; at least one entry is required. Any entry can activate the action, using the selected whole-word/phrase or contains-text match mode. Entries share the trigger's speakers, cooldown and delay; several matches in one finalized utterance still activate it only once. Blank lines are ignored and case-insensitive duplicate entries are removed. Existing single-phrase triggers keep working with the same stored records.


### Transcription model and segmentation

Admin → Settings → Application settings offers `large-v3-turbo` and `large-v3`.
The selection is stored in PostgreSQL. Only one model is loaded on the GPU.
First use downloads to the persistent model volume; the status shows downloading,
loading or restoring. Failed switches retain or reload the previous model.
Recording pauses and buffered speech is discarded during switching, so stale
speech cannot fire triggers. Discord sound playback remains independent.
The full model may improve recognition but is slower; compare representative Dutch
speech before choosing it. No accuracy improvement has been measured yet.

Capture uses a separate WebRTC speech detector per speaker, 20 ms frames, a
200 ms lead-in, 400 ms silence boundary and bounded five-second speech chunks.
The transcription worker additionally applies Silero VAD. Punctuation in trigger
phrases and recognized speech is ignored for matching.

Disabling recording deletes all conversation sessions and transcript messages,
hides the chat/history section and retains sound triggers. This is irreversible.
Recording controls remain available for enabling a new conversation.

Conversation shows only the live session, with no history selector or session pagination. Trigger search matches words, phrases and sound names immediately and case-insensitively; multiple search terms must all match.
