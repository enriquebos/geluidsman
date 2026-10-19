# Geluidsman

A shared Discord soundboard and music player with a video library and waveform clip editor.
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
Startup resets Discord voice state and reconnects the reported existing channel or the persisted last successful channel. Explicit Disconnect clears that restart target; graceful shutdown preserves it. Music is restored paused.

Production uses PostgreSQL. SQLite is used only by isolated development fixtures.
Startup initializes the current schema and recovers interrupted imports. A versioned upgrade helper applies compatibility changes once to unversioned databases, before creating indexes that depend on legacy columns. Historical activity and sound counters are seeded only when their original initialization markers are absent; existing totals and markers are preserved. Once `database_schema_version=1` is stored, startup skips these compatibility checks and historical audit aggregation.

The application is **1502044170406199416**, restricted to server
**1352422295402057759**. The bot needs View Channel, Connect and Speak. The token
is used only by the backend; the dashboard cannot read `.env`.

## Local macOS installation

Install Docker Desktop for Mac. In the existing ignored `.env`, set:

```dotenv
APP_BASE_URL=http://localhost:8687
APP_BIND_ADDRESS=127.0.0.1
COMPOSE_FILE=compose.yaml:compose.cpu.yaml
TRANSCRIPTION_URL=http://transcription:8000
```

Run `just update` (or `docker compose up -d --build --wait`), then open
**http://localhost:8687**. Compose reads `COMPOSE_FILE` from `.env`, so subsequent
`just start`, `just stop`, and other Docker shortcuts retain the CPU selection.
The CPU override builds without NVIDIA dependencies and uses CPU INT8 inference.
The dashboard port is accessible only from this Mac; transcription remains on the
private Compose network. CPU transcription can be slower than the NVIDIA worker.

Add `http://localhost:8687/api/auth/discord/callback` to OAuth2 → Redirects in the
Discord Developer Portal for your application, retaining the other PC's redirect
if it is still used. Keep the existing credentials and encryption key. Stop the
other PC's app before running the same Discord bot on the Mac.

Copying the repository and `data` directory does not transfer PostgreSQL's named
Docker volume. To retain accounts, permissions, library metadata and jobs, follow
the database backup/restore procedure below. Do not delete either machine's volumes.

## Apple Silicon GPU transcription

Apple M-series Macs can use the native MLX worker while the app and PostgreSQL
remain in Docker. Docker's Linux worker cannot use Metal; the Apple worker runs
on macOS. Install Poetry and native ARM64 Python 3.11–3.14, then run
`just apple-install`. It creates an isolated, locked environment in
`workers/apple/.venv`; dependencies for the Windows/Linux workers are unchanged.

In the existing private `.env`, set:

```dotenv
COMPOSE_FILE=compose.yaml:compose.apple.yaml
TRANSCRIPTION_URL=http://host.docker.internal:8000
TRANSCRIPTION_API_TOKEN=YOUR_RANDOM_SECRET
```

Generate the token locally with
`python3 -c "import secrets; print(secrets.token_urlsafe(32))"` and keep it only in
`.env`. Keep your configured dashboard URL, database credentials and encryption key.
When switching from CPU mode, stop the old worker once with
`docker compose -f compose.yaml -f compose.cpu.yaml stop transcription`.
Then run `just update`. `just start`, `just stop`, `just update`, and `just status`
manage both the native worker and Compose; use `just apple-logs` for native worker
logs. Direct Docker commands do not start or stop the macOS process. After updating
worker code, use `just update` to restart it. The Mac must stay awake during use.

The worker uses the Apple GPU through Metal, not the Neural Engine. The HTTP
listener uses port 8000 so Docker can reach the host; all routes require the
shared token. The token never appears in the browser, health status or command
arguments. Model downloads stay in `data/models/apple` and are pinned to specific
upstream revisions. Audio remains bounded in memory and is never uploaded.

The default recommendation is full-precision FP16 `large-v3-turbo` for live Dutch
and English speech. `large-v3` is also available for comparison, with a slower
full decoder. MLX uses a WebRTC voice-activity gate before inference, deterministic greedy
decoding and Whisper's no-speech filter; it does not offer the existing CTranslate2 beam-five decoder. Batch
requests preserve each speaker's audio separately and decode sequentially on the
GPU. Model loading includes a warm-up before reporting ready. Switching pauses
transcription, retains the previous model on failure and leaves playback available.
The model picker shows only models supported by the active backend. The existing
CTranslate2 Dutch fine-tuned model is unavailable on MLX; an incompatible saved
selection changes to the ready worker's model when status is refreshed.

Speed and accuracy depend on speech, model, simultaneous speakers and system load.
On this M2 Pro, a 5.805-second synthetic Dutch utterance took a median 0.703 seconds
with MLX Turbo, 1.233 seconds with MLX Large V3 and 4.465 seconds with CPU INT8
Turbo. Each median uses three HTTP calls after warm-up. All three produced one
word error in the same 17-word reference. This sample supports choosing Turbo
for latency, but does not establish accuracy for noisy Discord audio.
Use a user-controlled voice test to compare both models on your own microphones.

## Transcription vocabulary hints

Settings → Admin → Conversation includes shared Vocabulary hints under Keyterm Prompting. Enter one correctly spelled name, nickname, slang term or phrase per input, and use Add vocabulary hint for more. Start with a small relevant list; at most 100 terms and 500 characters in total are accepted. Existing newline/comma-separated settings load into separate inputs. Click Save vocabulary hints to apply changes to new speech. Clear hints empties the inputs; save afterward to disable them. The default list is empty.

Hints are stored in PostgreSQL and survive app, worker and model restarts. The local Apple MLX and CPU/NVIDIA backends receive the same short spelling prompt for each speaker's segment, without a model reload or previous transcript context. Deepgram Nova-3 receives individual keyterms when Keyterm Prompting is enabled. The prompt helps choose spellings when audio is ambiguous, but does not force
matches, train the model or repair clipped speech. Compare recognition with and
without hints on real examples. Silence filtering remains active.

Only administrators can read or change the list. Local workers receive bounded hints in a header on the private worker connection. The API provider sends enabled keyterms to Deepgram. Hints are excluded from health status, application logs and SSE events. The native Apple worker also requires its existing shared token. The dashboard tracks unsaved vocabulary edits for its
existing update/reload warning. The list can be saved while the model is unavailable.

## Command shortcuts

Optional [Just](https://just.systems/man/en/packages.html) shortcuts are defined in
`justfile`. Install on Windows from Command Prompt or PowerShell:

```text
winget install --id Casey.Just --exact
```

Open a new terminal after installation. On Linux, install `just` using your
distribution's package manager. Run `just` from the project directory to list
shortcuts. Windows recipes use Command Prompt; Linux recipes use `sh`.

| Command | Purpose |
| --- | --- |
| `just start` | Start the existing stack and wait for health checks |
| `just stop` | Stop the app first, then the worker and database; preserve data |
| `just update` | Build and deploy updated images with health checks |
| `just status` | Show container status |
| `just logs` / `just worker-logs` | Follow recent app / transcription logs |
| `just check` | Validate Poetry, strict Ruff and formatting |
| `just format` | Format Python source and tests |
| `just build` | Build the dashboard |
| `just test-backend` | Build and run the isolated Docker backend tests |
| `just test-browser` | Run desktop and touch browser tests |
| `just test` | Run both test suites |
| `just verify` | Check Python, build the dashboard and run both test suites |

Runtime shortcuts require Docker and the configured `.env`. Development shortcuts
also require the native development dependencies described below, installed Poetry
and npm dependencies, and Playwright Chromium. Before the first Docker backend
test, start the database and create the isolated test database once:

```text
docker compose up -d --wait db
docker compose exec -T db createdb -U geluidsman geluidsman_test
```

Use your configured PostgreSQL user if different. Browser tests use their existing
isolated fixture and never join Discord voice. For CPU-only installations, set
`COMPOSE_FILE` to `compose.yaml;compose.cpu.yaml` on Windows or
`compose.yaml:compose.cpu.yaml` on Linux before running shortcuts; Docker Compose
applies that selection to every runtime and backend-test command. Just does not
load `.env` itself; Compose continues to manage secrets. Direct commands and the
backup/restore procedure below remain available.

## Consistent sound loudness

New uploads and video cuts automatically measure integrated loudness using
FFmpeg and apply a constant gain toward **-16 LUFS**, limited to **-2 dB true peak**
and at most **24 dB amplification**. The normalized PCM also produces the browser
preview. Processing happens once at creation, never during Discord playback.
Sound volume remains an adjustable multiplier; 100% uses the normalized baseline.

This preserves dynamics and exact duration rather than compressing the sound.
Sounds with large peaks may stay quieter to preserve headroom. Clips too short for
integrated loudness use a -19 dBFS RMS fallback with the same peak ceiling; silence stays silent. Normalization
does not remove noise, repair existing distortion or prevent clipping from boosted
volume or overlapping playback. Listen with the existing browser preview controls.

The existing sound library was normalized and every saved sound volume reset to
100%. After listening and approval, the temporary batch tool was removed.
Existing sound clips are not processed again at startup. Music uses the resumable
measurement process below, without rewriting its cached audio.

## Music loudness and existing recordings

Downloaded YouTube recordings and uploaded MP3s use the same **-16 LUFS** target,
**-2 dBTP** ceiling and **+24 dB** maximum amplification. FFmpeg measures integrated
loudness and true peak, then playback applies a single constant gain. Recordings
with large peaks or very low levels remain quieter when either limit prevents
reaching the target. There is no compressor, limiter, silence trimming or speed
change. Very short recordings below the integrated-loudness gate use the existing
-19 dBFS RMS fallback with the same gain and peak limits; silence keeps zero gain.

Original compressed recordings remain byte-for-byte unchanged. Measurements live
in the existing `data/music-cache/*.json` manifests, alongside their cached audio,
not in a second audio cache or a newly encoded copy. Normalization policy version 1
is paired with the recording's filesystem identity, size and nanosecond modification
and change times. Replacement invalidates the measurement even when the size stays
the same; shared recording aliases and identical uploaded MP3s reuse one result.
Restoring or moving files in a way that changes that identity can require analysis
again. Back up manifests with the audio files.

One background worker discovers unfinished entries during the normal cache load
and resumes after restart. Successfully measured recordings are skipped; newly
downloaded or uploaded files join the same bounded queue. Its single-threaded
FFmpeg process runs at reduced OS priority and yields to downloads, media storage
reservations and playback preparation. Analysis does not run in the event loop or
audio thread, fetch another copy, change download concurrency or rewrite playlists,
Likes, queues or sources. Large libraries can take time, especially during imports.

Gain is fixed when a playback starts and remains fixed through pause/resume and
seeking. Pending or failed analysis uses the original level until a later playback;
finishing background analysis never adjusts an already playing recording. The
decoder applies the measured gain once in the existing 48 kHz stereo playback
format, before the separate user master-volume stage. The -2 dBTP ceiling applies
to that normalized PCM at 100% master volume; deliberate volume boosts and later
lossy Discord encoding can change the final peaks.

Downloads keeps available files in Completed while measurement is queued or running.
Song download details show measurement status and the calculated gain. Analysis
failures appear in Needs attention and in the song's download details. Authorized
Retry repeats analysis of the retained file, without downloading it again. Failed
measurements are retained across restarts rather than retried in a loop. Missing
YouTube files use the existing download retry; missing uploads require uploading
the recording again. Corrupt recordings remain available for source replacement.

## Page URLs

The sidebar opens Soundboard, Music and Settings. Soundboard uses a resizable vertical navigation pane for Sounds, Video library, Conversation, Actions and Hall of shame, alongside a content pane that scrolls independently. Its navigation ends at Hall of shame; sound categories remain in the content pane. The navigation collapses to icons on narrow screens and remembers its desktop width. Settings contains Personal settings, Admin and Audit log according to permissions. The audio-mode switch remains separate from page navigation, so sound creation and rule editing stay available while Music is active.

The soundboard is `/soundboard`, Music is `/music`, the video library is `/videos`, and the waveform editor is `/videos/{video_id}/cut`. These URLs work directly and survive reloads.
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

`/settings` contains personal preview volume and caption language, using compact rows that apply changes automatically. Settings uses the same resizable page panes as Soundboard, with an expandable Admin navigation group and Audit log according to account permissions. The app sidebar, connection header and playback bar keep their existing controls. `/admin` contains application settings; `/admin?tab=console` opens sanitized website/bot logs. The console keeps up to 2,000 entries in memory until restart; error entries include stack traces. App admins can change import
limits, sound-library storage limits and audit retention. General settings show sound-library usage separately from music downloads and their independent cache limit. Unsaved manual settings require confirmation before changing sections or pages, including browser back/forward; cancelling keeps the draft. Browser refresh/close uses the browser’s unsaved-work warning. These database overrides apply to new
operations; running imports retain their snapshot of limits. `.env` supplies
defaults for settings without an override. Eight simultaneous sounds are
supported in the configured server with one connection and master volume.

Settings sections use the same flat page surface, section headings, row spacing and bounded controls, with labels and descriptions on the left and controls on the right. Narrow panes stack fields consistently. Shared feedback shows saving, saved and error states. Personal preferences, permissions, Fun settings and provider/model/language selection still apply automatically; General settings, API options, vocabulary and drawings retain explicit Save controls. Manual saves show unsaved changes, keep drafts after failure and disable unchanged saves. Goose commands report sending and sent states separately from saved drawings.

The Admin group contains **General**, **Conversation**, **Permissions**, **Fun**, **Goose** and **Application console**. General retains `/admin?tab=settings`; other destinations use their existing query values, plus `tab=console`. The selected destination survives reload and browser history. The console keeps its loaded entries, level filter, pause setting and reading position while navigating Admin and personal settings. Hidden console views stop polling and resume from their cursor when shown again. Permissions lists
registered users with search and 50-user pagination. Select a user; permission switches update immediately, or reset them to defaults. Configured `.env` admins inherit all permissions except **Use Geluidsman outside voice**, which is off by default for everyone. Only the protected user can change
their own other permissions for testing; admin access remains locked on. Reset
restores those defaults. Other administrators cannot modify protected accounts.
Admin panel access does not bypass other permissions.

Permissions cover playing/stopping sounds, voice connection/disconnection,
master volume, mute/deafen, creating/editing/deleting sounds, video/channel
imports, import-job management, video deletion, and audit access. Ordinary accounts inherit permissions except admin access, boosted sound volume, extended sounds, master volume, mute/deafen, channel import, recording control and outside-voice control. Edit/delete all includes the user's own sounds;
unattributed legacy sounds require the corresponding all-sounds permission.
Retrying an import also requires its import permission; resuming a channel
requires channel import and job management. Browser previews, browsing,
personal favourites and personal settings remain available to signed-in users.

Entering Settings as an authenticated administrator prepares the permission catalogue and first 50-user page independently. Permissions and playlists share the confirmed-resource loader with the other prepared views. The cache retains at most five permission pages, preserving the first page. Cached values remain hidden until an authorized current response or matching ETag confirms them. Entry, focus, reconnection and relevant events revalidate; failed validation shows an inline retry instead of old rows or a false empty state. Only typed searches wait 200 ms; initial entry and pagination start immediately. Successful permission saves invalidate affected pages and validate current rows; older reads cannot replace newer confirmed results. Logout, account changes and access changes clear private memory.

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

Tests use explicit isolated fixture identities; production has no anonymous/test-auth fallback.

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

Dashboard and General settings reads use current application storage-ledger totals and off-thread dependency checks. Other internal summary consumers may reuse summaries for up to five seconds. Import/extraction storage checks always scan fresh usage; the
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

Voice handshakes have a 30-second limit and a separate 15-second outer cleanup allowance. A disconnected voice client gets 30 seconds for library recovery before replacement, and failed connections retain their automatic retry target. Healthy connections have no idle timeout; the soundboard mixer continues sending silence while idle. Explicit Disconnect cancels pending recovery and clears the target, with a 10-second cleanup bound. Deployments gracefully disconnect voice before startup restores the previous connection; music returns paused.
Sanitized bot and website diagnostics also appear in `docker compose logs app`.


## Conversation transcripts and sound triggers

Open `/conversation` to see live speech as chat bubbles, your own on the right and other speakers on the left. Access Conversation page is enabled by default for ordinary users; explicit access denials remain enforced. Reading live transcripts also requires presence in the bot’s voice channel unless Use Geluidsman outside voice is granted; that permission is off by default for every account. The navigation item is hidden when access is denied, and direct API requests are also checked. Protected administrators can grant this permission to themselves; admin access alone does not waive voice presence. The recording switch is shared and persists across restarts; recording is enabled by default; startup reconnects a previously active channel after resetting voice state. In Soundboard mode, connecting starts transcription once the selected provider is ready. Recording status and included participants are visible on the Conversation page; the bot does not send transcript notices in voice-channel text chat. Disabling recording stops capture and triggers. Deafening the bot pauses recording until someone with voice-toggle permission undeafens it; changing channels or losing the voice connection ends the session.

Administrators select either a local Whisper worker or Deepgram Nova-3; provider failures never switch to the other provider automatically. Local processing keeps audio on the host/private worker connection. Deepgram streams each speaker's audio to its API. Both paths keep bounded application audio buffers and do not save audio recordings. Finalized transcript text, speaker identities and timestamps are available only during the active conversation. Closing the session, disabling recording or restarting the app deletes them. There is no saved conversation history or retention setting. Transcript text and audio are excluded from logs and SSE payloads. Playback history records trigger and speaker IDs, with skipped-playback explanations.

The Compose transcription service uses its own image, NVIDIA CUDA FP16 inference and a persistent transcription_models volume. The default stack reserves an NVIDIA GPU; Windows requires Docker Desktop with WSL2 GPU support, and Linux requires NVIDIA Container Toolkit. Its HTTP interface has no published host port. The first start downloads the model; later starts reuse the volume. Run `docker compose up -d --build` for the full stack and `docker compose logs transcription` for worker startup diagnostics. `docker compose exec -T transcription python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health').read().decode())"` reports model readiness. TRANSCRIPTION_URL is an internal worker address, not the dashboard URL. Linux and Windows use the same GPU stack. For machines without an NVIDIA GPU, use `docker compose -f compose.yaml -f compose.cpu.yaml up -d --build` to select CPU INT8 inference; use the same two Compose files for later stop or restart commands. Back up PostgreSQL for users, permissions, library data and triggers. The model volume can be recreated from its upstream download.

Create word-to-sound triggers below the chat. Choose whole-word/phrase or contains matching, select everyone, yourself or specific Discord speakers, and set a cooldown (five seconds by default; zero is supported). Matching is case-insensitive and runs only on finalized speech. Each matched utterance fires a trigger once. Users with Conversation access can view all shared triggers, including their creator and enabled status. Anyone with Conversation access and trigger-management permission can edit or toggle any trigger, while its original creator remains unchanged. Deletion is restricted to the creator or admins with the relevant permissions. Playback rechecks the creator's permissions and channel access, uses the existing mixer, and rejects full capacity instead of queuing stale sounds. The bot's incoming stream is excluded; human microphone echo and recognition mistakes can still activate triggers.

The receive extension is pinned to commit 78fcb434a3484f2abf54cf89e80e86b651e5c28d of discord-ext-voice-recv-dave. The receive integration uses Discord's normal bot connection and DAVE decryption, not a user account. Tests cover application capture, speaker separation, lifecycle and trigger behavior without joining Discord voice. A user-controlled live session is still required to validate encrypted audio reception in the actual server.


Soundboard audio uploads

Choose **Add a sound** on Soundboard to drop or select an `.ogg` or `.mp3` file, preview it, and set its name, emoji, tags and volume. Upload previews use the personal browser preview volume, including zero. Files must contain audio, last 0.1–60 seconds (or the configured clip limit), and be at most 20 MB, subject to import and total storage limits. Uploads use the create-sounds permission, retain creator attribution and audit history, and do not create video-library entries. Original uploads are discarded after conversion to playback and preview formats. Existing video clips remain unchanged.

Caption search accepts partial final words and near spellings, with exact matches first. Search begins after 100 ms of typing and keeps previous results visible while updating. Matching speech is highlighted and retains supplied word timestamps where available. PostgreSQL uses indexed full-text and trigram candidates before ordered phrase matching.

Conversation starts in Dutch to avoid misdetecting short Dutch utterances as English. Users with recording-control permission can select Dutch, English or automatic detection on the Conversation page; the shared selection persists across restarts. The same Discord connection controls are available on Soundboard and Conversation. Scrolling up in the admin console pauses Follow latest; enable it again to return to live logs.

Local transcripts finalize after approximately 400 ms of silence. Continuous local speech is split into bounded five-second segments, then processed by the selected Whisper model with Dutch as the default language. Deepgram finalization instead follows the configured streaming endpointing and utterance-end options. Completed transcript events fetch live messages immediately without waiting for trigger-list refreshes. Shorter segments reduce waiting but can affect recognition at boundaries; actual latency also depends on inference throughput and transcription backlog.

The emoji picker uses Unicode Emoji 17.0 metadata from iamcal/emoji-data, pinned to commit 13ee711e222ea17fe537bfea953c687866f16411. The MIT license and dataset provenance are in frontend/src/data. It contains 1,878 standard emoji plus the configured server custom emoji, with left-side categories and alias search. Skin-tone variants remain excluded. Standard artwork depends on the browser and operating system. The catalog loads on demand.

Speech preprocessing filters 48 kHz audio before converting to 16 kHz and retains up to 200 ms of quiet lead-in per speaker to preserve word beginnings. The CPU/NVIDIA CTranslate2 worker uses beam size five with the selected multilingual Whisper model; Apple MLX uses its deterministic greedy decoder. Deepgram receives mono 16 kHz streaming audio and uses its API settings. These improvements cannot correct all microphone noise, overlapping speech or missing context.

Soundboard sections appear in this order: Pinned, Frequently used, Top sounds, All sounds. Sounds can appear in multiple sections; All sounds always contains the complete filtered collection. Frequently used selects up to 20 sounds ranked by your successful Discord plays; Top sounds selects up to 20 sounds ranked by successful server plays. The selected sounds display newest first. Durable counters outlive audit cleanup and exclude browser previews and rejected playback. Search and tags filter every section. Collapse choices are saved per user in this browser. Default and Compact modes are saved to your account; Default retains the detailed cards. Compact cards show preview on the left, pinning on the right, and Discord playback in the center. Right-click or Shift+F10 opens sound actions on either style; editing remains subject to ownership permissions.

Conversation triggers support Play sound or Stop all sounds, with a 0–60 second delay separate from cooldown. Delays run in a bounded set of 32 pending actions without blocking transcription. Ending a session cancels pending actions; editing, disabling or deleting a trigger prevents its pending action from firing. Creator permissions and active-channel access are checked at execution. Stop all requires stop-sounds permission and stops the shared mixer; browser previews are unaffected. Saved triggers retain their configured action and delay. Conversation and trigger deletions use themed confirmation dialogs.

Conversation is labelled BETA. Local CTranslate2 workers use FP16 on NVIDIA or four CPU threads with INT8 when the CPU Compose override is selected. This is an explicit installation choice, not an automatic fallback. Apple MLX runs natively on the Mac GPU. Local models are cached persistently; first use downloads the selected model. Deepgram uses Nova-3 and does not load a local model. Actual microphone accuracy requires a user-controlled live test.

Soundboard sections display sounds newest first by creation time. Frequently used
and Top sounds select their highest-ranked 20 sounds, then display that selection
newest first. Sound volume sliders always show 0–1000%; without the **Boost sound
volume to 1000%** permission they stop at 300%. The higher segment is visibly
restricted. Creation, upload and editing APIs enforce the same permission and
absolute 1000% limit. Browser previews still cap gain at 100%.

New cuts from the video editor always start at 100% volume. Adjust volume later
in the sound editor. Permission edits update the selected user locally without
refetching the user list; searching or changing pages still loads the matching users.


With the local provider selected, finalized utterances wait at most 40 ms to collect a batch of up to four. The worker applies voice activity detection separately to each utterance and decodes independent audio regions together; speaker audio is never mixed. Automatic language mode detects each utterance separately and groups compatible languages. Queue and request bounds remain enforced, and session changes or stale results prevent transcript saving and trigger playback. The worker exposes `/transcribe/batch` only on the internal Compose network; its `/health` response reports readiness, requested device and maximum batch size without transcript content.

The GPU dependencies are locked in Poetry's optional `gpu` group and included only in the transcription image. CUDA/cuDNN libraries are supplied by the image; the host needs a compatible NVIDIA driver. The model cache and PostgreSQL data volumes remain unchanged. GPU initialization failures remain visible through worker health and the conversation status; the default stack does not silently fall back to CPU.


A local warmed-up benchmark on the Ryzen 7 9800X3D / RTX 5080 processed one five-second library sample in a median 2.810 seconds on the previous CPU INT8 worker and 0.187 seconds on GPU FP16. Four copies decoded together took 0.391 seconds per batch. These are inference/HTTP timings from three measured runs after warm-up, not end-to-end live-call latency or an accuracy benchmark. Finalization silence, batching wait, microphone quality, utterance length and system load still affect the user experience; batched decoding can produce different wording from individual decoding.


Conversation triggers accept up to 20 alternative words or phrases, each in a separate input with up to 255 characters. Use Add word or phrase to add an entry and its remove button to delete it; at least one entry is required. Any entry can activate the action, using the selected whole-word/phrase or contains-text match mode. Entries share the trigger's speakers, cooldown and delay; several matches in one finalized utterance still activate it only once. Blank lines are ignored and case-insensitive duplicate entries are removed. Existing single-phrase triggers keep working with the same stored records.


### Transcription model and segmentation

Settings → Admin → Conversation selects the transcription provider, model and language. Local CTranslate2 offers `large-v3-turbo`, `large-v3` and `yuriyvnv/whisper-large-v3-high-mixed-nl` (Dutch fine-tuned); Apple MLX offers Turbo and Large V3. The model picker includes only models supported by the active worker. Deepgram uses Nova-3 exclusively. The selection is stored in PostgreSQL. Local workers load one model at a time.
First use downloads to the persistent model volume; the status shows downloading,
loading or restoring. Failed switches retain or reload the previous model.
Recording pauses and buffered speech is discarded during switching, so stale
speech cannot fire triggers. Discord sound playback remains independent.
The full model may improve recognition but is slower; compare representative Dutch
speech before choosing it. No accuracy improvement has been measured yet.

The Dutch fine-tuned model is pinned to revision
`8975a419ff1300e407ef6ae00b70d756fc9a65d2`. Its original safetensors are
downloaded and converted locally to CTranslate2 FP16 on first use. Both the
download and completed conversion are cached in the persistent model volume.
The worker has a 12 GB memory limit to accommodate conversion; CPU PyTorch is
used only for conversion, while inference retains the configured GPU/CPU mode.
Adding this option does not change the current selection or default model.

Local capture uses a separate WebRTC speech detector per speaker, 20 ms frames, a 200 ms lead-in, 400 ms silence boundary and bounded five-second speech chunks. CTranslate2 additionally applies Silero VAD; MLX uses a WebRTC gate and Whisper no-speech filtering. The API provider streams independent speakers using its configured endpointing. Punctuation in trigger
phrases and recognized speech is ignored for matching.

Disabling recording deletes all conversation sessions and transcript messages,
hides the chat/history section and retains sound triggers. This is irreversible.
Recording controls remain available for enabling a new conversation.

Conversation shows only the live session, with no history selector or session pagination. Trigger search matches words, phrases and sound names immediately and case-insensitively; multiple search terms must all match.

### Voice Actions

Actions sits below Conversation at `/actions` and works even when recording is
turned off. **Access Actions page** is enabled by default; admins can deny access in Admin → Permissions. **Manage action triggers** allows shared creation, editing and toggling.
Only the creator or an administrator can delete a rule.

Rules respond to camera, self-mute, self-deafen, stream and join/leave transitions
in the bot's current channel on the configured server. Server-imposed mute and
deafen, bots, other channels and initial connection states are ignored. Choose
Play sound or Stop all sounds, everyone/creator/selected participants, a delay
from 0–60 seconds and a shared cooldown from 0–3600 seconds. Defaults are camera
enabled, Play sound, everyone, no delay and a five-second cooldown.

Pending work is bounded to 128 and cancelled when the connection changes.
Execution rechecks the unchanged rule, creator permissions, server membership,
channel access and participant presence (leave actions allow an absent participant).
Deleted sounds and capacity failures are skipped without retry and appear in the
audit log. Successful playback also contributes to normal sound statistics.

Deployment adds the action-trigger table while preserving existing users, media,
permissions and jobs. Startup reconnects only a reported or persisted active connection after resetting voice state. Automated verification
uses simulated events; real Discord events still require a user-controlled call.

Actions additionally supports **First person joins**, ignoring bots when checking
whether the channel was empty, and **Someone starts/stops speaking**. Speaking
uses the voice receiver's activity transitions, with roughly 200 ms without voice
packets ending a speaking period. It does not run a transcription model and may
react to microphone noise. The bot must be undeafened; this never overrides an
explicit deafen action. When recording is off, a lightweight receiver discards
Opus packets without decoding or saving audio. Recording shares the same speaking
events through its existing receiver. Receiver handoffs invalidate old callbacks,
and connection changes discard speaking state and pending actions.

The action editor groups controls into When, Who, Then and Timing, with a
single-column layout on smaller screens.

### Project conventions

Follow [AGENT.md](AGENT.md) for UI, authorization, performance and verification rules.
Conversation triggers are shared and unique per sound across all users; add alternative
words to the existing trigger rather than creating another one. Speaker selection
combines registered users and voice participants in one searchable checkbox dropdown.

Manual soundboard playback requires the player to be in the bot's active voice channel
unless **Use Geluidsman outside voice** is granted (off by default).
Automatic Conversation and Actions triggers do not require their creator to be in voice or have outside-channel permission. The triggering human participant must belong to the configured guild, have access to the active channel and remain present for speech and non-leave events. Actions leave events use the channel the participant left and remain eligible after departure. Delayed execution rechecks participant eligibility, the creator's action permissions, guild membership and channel access, rule/session validity, cooldowns, capacity and Actions precedence; ownership and manual playback rules are unchanged. The speaker picker lists human guild
members through Discord's REST API with a 60-second shared cache. The connection
bar is the global header; sidebar participants show the active bot channel.

Hall of shame is available at `/hall-of-shame` with the activity-view permission. Its all-time totals are initialized from existing audit records and then retained independently of audit cleanup. Activity already deleted before this feature cannot be recovered. The graph has an independent period filter. Graceful shutdown disconnects voice first; startup resets and reconnects the reported or persisted last active channel. A hard kill or power loss cannot send a disconnect; Discord controls removal until startup recovery.

Live conversation remains on the Conversation page and is also available from a floating chat button across the app. Personal preferences save automatically; toasts appear at the top right. The button is disabled without an active recording session. Reading transcripts requires being in the bot’s voice channel, unless Use Geluidsman outside voice is granted. That permission is off by default for every account and does not replace Conversation page access. Backend checks apply to every message request; leaving voice removes transcript access.

The sidebar contains Soundboard, Music and Settings. Soundboard navigation includes Sounds, Video library, Conversation, Actions and Hall of shame; Settings navigation includes Personal settings, an expandable Admin group and Audit log according to account permissions. Its page panes scroll internally; Admin sections share that vertical navigation, and the console is a separate destination. Existing page URLs and browser history remain supported. When human participants are connected, the sidebar names the bot’s voice channel above them; the members section is hidden when empty. Connection state and mute/deafen state appear in the header; muted, connecting and reconnecting use an orange icon. Active playback chips show progress without extra network polling, and the accessible Bot volume slider controls Discord output without a visible label. Active sounds glow across browsers in both soundboard layouts. Compact controls appear on hover or keyboard-visible focus; pointer playback does not retain the hover state.

Admin permissions label inherited values as Default and explicit values as Custom override, with an overrides-only filter. Personal settings use full-width panels. Voice channel 1355614484797980723 is excluded from channel selection and backend connection checks. Playback progress follows mixer positions pushed over SSE every half-second while sounds are active, rather than advancing from browser elapsed time. The bar transitions smoothly between those authoritative positions without predicting ahead. Toasts sit below the top bar while it is visible and move to the top when it scrolls away.

Recording control is disabled by default for ordinary users. Matching inherited permission values are displayed as Default rather than Custom override. Playback progress interpolates confirmed mixer positions and stays active until server-confirmed completion. Automatic triggers may play sounds uploaded by any user; sound ownership applies to editing and deletion, not playback.

Voice connection handshakes are limited to 30 seconds, with a separate 15-second outer cleanup guard. Failed handshakes retain the requested channel for automatic retries. A disconnected voice client gets 30 seconds for library recovery before being replaced. These limits apply only to connection recovery; healthy voice calls have no idle timeout.

The default-off Create and upload sounds up to 10 minutes permission raises video-cut and audio-upload duration to 600 seconds and audio-upload size to 100 MB. Ordinary users retain the configured standard duration (60 seconds by default) and 20 MB upload limit. Existing create-sound permission, source boundaries, import/storage budgets, and supported-format checks still apply. Playback of an existing long sound does not require this creation permission.


### Performance changes

Media usage is tracked per local revision and updated after successful imports, extraction, uploads and deletion. Quota checks measure staged files before committing them, and existing media writes remain serialized. The initial scan and ten-minute reconciliation run outside the event loop. Change media through the app; externally edited files can take up to ten minutes to appear in usage totals. Atomic media saves finish before shutdown cancellation can remove their files.

Async database work uses four bounded worker slots with the existing transaction lock. Authenticated requests still read effective permissions from PostgreSQL every time. Caption cues use pipelined batch inserts and one search-index insert per track, preserving transactional refresh rollback. The additive transcript arrival-order column/index allows incremental updates to include late speech from overlapping speakers.

Each browser tab shares one authenticated event stream. Inline and floating chats share permission-checked transcript fetches and history, load only newer messages after initialization, and clear their store when the session becomes inaccessible or the last view closes. Transcript text remains outside SSE. Editor and admin routes load on demand.


### Fun effects and trigger credit

Admin → Fun has independent, instant toggles, initially off and stored persistently. Enabled sound effects reach signed-in browsers whose Discord account is in the bot’s active voice channel, regardless of who played the sound. Membership is checked at publication, delivery and display. The existing event stream uses server-measured elapsed time so device clock differences do not discard effects. Flashbang whites out the page after 600 ms and fades; Vine boom briefly zooms/shakes with The Rock centered in the viewport. The effects use protected sound IDs `2beec8ee6e7148f89e44770189b2b555` and `325a0351de6e4b27a6bc1a6799b05e2f`, respectively. These sounds cannot be deleted even when effects are disabled. Sounds with matching names do not activate effects. Browser previews do not activate effects. DVD screensaver is a separate silent visual toggle: its logo bounces and corner hits emit confetti. Reduced-motion preferences suppress shake, bouncing and confetti.

Automatic Conversation and Actions playback credits the human participant who caused it, rather than the rule creator. Discord participants without app accounts appear in Hall of shame using their Discord identity and count toward plays. Creator permissions and channel authorization remain unchanged, and the audit details retain the creator ID. Historical attribution is not rewritten.


DVD speed can be set from 0.25× to 5× beside its Fun switch; it applies without restarting the animation. SUS has its own default-off toggle and is bound to protected sound ID `c48f9c6f2bdf4cd99536f594c9ef2f1b`. It floats a red crewmate left to right for app viewers in the bot's voice channel, using the same broadcast and membership checks as Flashbang and Vine boom.

Startup now resets Discord voice state before reconnecting to the reported channel or the persisted last successful connection. If Discord still reports the bot in voice, startup waits for its leave confirmation. Graceful shutdown preserves this reconnect target; using Disconnect clears it. Connection, guild/channel permissions, exclusions and bounded recovery still apply. Restart verification uses mocks and does not join a live voice channel.


Goose and Kirby are independent, default-off Admin Fun settings. Goose wanders independently across the app, occasionally showing cursor interest, and hides on touch-only devices. Kirby counts authorized manual playback attempts, including capacity rejections, across each account’s devices: default 20 within 5 seconds, configurable from 1–100 attempts and 1–60 seconds. The threshold-reaching request pauses that account’s manual playback for five seconds and inhales its soundboard cards. Existing playback, previews, automatic triggers and other accounts are unaffected. Repeated requests do not extend the pause. Disabling Kirby clears pauses; restarting clears transient counters. Use account-filtered SSE and monotonic elapsed timing, bounded buffers, pointer-transparent visuals and reduced-motion behavior.


## Frontend deployment updates

Every Vite production build gets a unique ID embedded in its JavaScript and `frontend/dist/build.json`. Deploy the complete frontend output with its backend; keep that metadata with the build. Backend restarts reuse the same build ID. Rebuilding locally requires restarting the backend serving that output. Vite development mode does not show production update notices.

HTML uses `Cache-Control: no-cache`. Only generated content-hashed assets listed in the build metadata receive `public, max-age=31536000, immutable`; other static assets are revalidated. Private APIs and media remain uncached.

The existing authenticated SSE connection reports the serving build on every initial connection and reconnection. Existing state refreshes also compare IDs when returning to a visible tab. A mismatch shows one persistent, accessible update banner. Missing or malformed version information does not interrupt the app. The notice remains until reload; it never forces a reload or clears storage, cookies, preferences or sessions. Error and confirmation toasts stack beneath the update banner, including when it wraps on smaller screens or the connection bar scrolls away. Refresh keeps the current path, query and hash, and asks before discarding tracked unsaved editors, uploads or application settings. Finish active work before choosing to refresh.

Tabs opened before this feature was deployed still need one manual refresh to install the version checking code. Keep the previous build's assets available if uninterrupted loading of previously unvisited lazy pages across deployments is required; the current stack replaces its build assets on deployment.

The application server closes existing SSE streams when shutdown begins, allowing graceful bot/media cleanup and native EventSource reconnection after an app restart instead of holding shutdown open until Docker forcibly terminates it.

Goose walks independently with alternating steps and body bobbing. Pointer movement never cancels committed antics or drawings. Cursor opportunities occur every random 20–40 seconds of visible, pointer-present time, wait for idle activities, and lead to a short investigation or a bounded 3–6 second chase after noticing and stalking. Nearby glances and recoils are debounced; leaving or losing focus cancels only cursor interactions. Hidden tabs pause behavior deadlines, drawing expiry and animations; reduced motion removes walking. Kirby enters from the right, visibly inhales cards, then leaves without an on-screen message or countdown. Repeated Flashbang, Vine boom and SUS plays create independent, bounded effect instances rather than replacing an active animation. Startup recovery captures Discord's reported voice channel before resetting it and rejoins that channel, even when the saved target differs.

When a desktop cursor leaves the page, Goose immediately abandons its cursor target and wanders from its current position. Idle Goose occasionally hops or draws temporary red-pen scribbles; keep marks bounded, local and pointer-transparent. Kirby stops inhaling before leaving, and restored sound cards slide in from the right; reduced motion restores cards without movement.

Goose doodles randomly selected smileys, self-portraits and Shrek line sketches using a shaded red pencil. Reveal each stroke sequentially and position the actual pencil tip at the same SVG path point; keep geometry cached and update the drawing directly rather than rendering React on each frame.

Kirby ignores duplicate active-pause updates, keeps its animation age stable, and removes inhale wind before exiting. Goose keeps jump headroom, walks into drawing position and between separate strokes, draws sketches more slowly, and can leave a randomly generated five-second walking trail.

Goose SVG overflow must stay visible so jumps are not clipped. Shrek uses green ink. Idle behaviors include temporarily borrowing and returning card emojis, inspecting buttons without activating them, tumbling by the playback bar, napping until playback, chasing an enabled DVD logo and fleeing on its bounce, and an egg that hatches into a short-lived follower. Restore borrowed DOM styles and remove props when interrupted, disabled or unmounted.

Top sounds ranks all-time successful plays using durable per-sound/account/server counters. Audit cleanup does not reset rankings. Existing retained audit records initialize these counters once; previously deleted audit records cannot be recovered.

Soundboard creator filtering uses a searchable multi-select between grid layout and sound search, combining with tags and text search across every section. Empty selection shows everyone; legacy sounds have an Unknown creator option.

Goose selects weighted random idle activities from available targets, discouraging its last three choices. It blinks and uses suspicious, sleepy and curious expressions, with cautious stalking, emoji-carrying marching and sleepy waddling. Failed chases skid, look around and briefly pretend to inspect a nearby button, then return to wandering without bypassing cursor cooldowns. Drawing completion includes stepping back and a proud nod; occasional temporary cross-outs use the same pencil-tip/path alignment. Eligible SUS, Vine boom and Flashbang visuals may prompt a short silent reaction only when free; stale or committed-time reactions are discarded. Naps wake only for newly observed playback IDs, never recurring progress updates. Keep all timelines paused while hidden and restore borrowed elements and props on cleanup.

Goose goslings follow through other activities with one shared 60–120-second visible-time deadline set at the first hatch. Later hatchlings inherit it; all leave together toward the nearest edge in a leader-following formation, with no hatching during departure. Broods favor one gosling (70%), then two (22%), three (7%) and four (1%), with at most four living followers. Hidden time pauses their lifetime; disabling Goose, touch-only capability or reduced motion removes them.

Goose occasionally displays silent Honk Honk speech or an “Ik verlang naar m'n urn” thought bubble when unoccupied. Bubbles stay within the viewport and expire on visible time. Expired goslings walk to the nearest screen edge and leave completely before removal; disabling effects still cleans up immediately.

Admin → Goose sends a trimmed 1–30-character silent message through the existing authenticated SSE connection to all currently connected clients. The five-second bubble follows a visible Goose, with a standalone mobile/disabled-Goose fallback. No voice membership or Goose toggle is required; messages are transient, plain text, bounded and never replayed after reconnect.

Admin Goose also broadcasts a bounded five-goose raid, a chosen sketch drawn by the existing companion after its current activity, with a visiting-goose fallback, and sign delivery using the message field. All are silent, pointer-transparent and available to mobile/disabled-Goose clients; motion pauses while hidden and reduced motion uses static actors. Visiting raids and sign deliveries replace the prior visiting command; companion drawing requests replace only pending drawings. Sent speech contains no emoji. The automatic urn thought remains visible for ten seconds.


Admin Goose includes a mouse/touch/pen drawing editor with six colours, Undo, Clear and named shared drawings. Saved drawings use the separate PostgreSQL `goose_sketches` settings key; authenticated clients read `/api/goose/sketches`, while admin-only create/update/delete APIs live under `/api/admin/goose/sketches`. Only bounded numerical coordinate arrays are accepted: at most 16 drawings, 60-character names, 32 strokes and 512 simplified points per drawing. Estimated ink and pencil-travel time must not exceed 60 seconds. Active drawing snapshots survive editing or deletion. Saved drawings also join the existing random idle sketch pool without increasing activity frequency.

Manual draw broadcasts resolve saved IDs server-side and use the existing SSE connection. A visible desktop companion finishes its current activity, cursor interaction or drawing inspection, then walks to the new drawing. Each client keeps one pending request for up to 120 seconds of visible waiting time; newer requests replace only pending work. Playback timing starts on arrival. The companion stays afterward and goslings keep following. Without a visible companion, a temporary visiting goose draws; reduced motion shows static art. Complete drawing scenes, including pencil and goose, are randomly positioned inside the central 60% of both viewport dimensions, scaled for small screens and repositioned on resize without resetting stroke progress. Hidden tabs pause all behavior time. Enabled desktop companions load the library once, then refresh only after library changes or SSE reconnection, without adding a connection or polling. Unsaved drawing edits participate in the existing refresh warning.

Browser preview volume stays local while dragging and saves only on pointer release, keyboard adjustment release or leaving the slider. Cancelling a pointer gesture discards its uncommitted value.

Brief Discord gateway interruptions preserve the existing voice client and mixer. Pending automatic actions and the transcription session are invalidated; gateway resumption refreshes clients. Only actual voice failure triggers voice recovery, with a 30-second handshake limit. Explicit disconnect and shutdown still leave voice.

Admin Fun includes a default-off Brr Brr Patapim switch. Protected sound ID `75dcb32953744dbdaa0c4f6aa5445c0f` (BRR OPSTAAN) sends a local SVG tree-monkey character walking across eligible voice participants' screens for six seconds. Repeated plays overlap, previews do not trigger it, and reduced motion shows a static character.

The default-off Tung sahur Fun toggle binds protected sound ID `1e5721474c58461ebfd99751b681bb3b`. Eligible voice-channel viewers see the wooden character enter, swing his bat and crack a decorative screen overlay, then leave within six seconds. Each playback has its own effect instance; nothing changes the real page or blocks clicks. Reduced motion shows a static character and cracks.

Default-off Skibidi and Spion Fun toggles use protected sound IDs `abfeb407046948a2a78a0e693bd35bfa` and `5592b9d7f19a418796c2c8a47dcefe52`. Skibidi's SVG toilet appears for six seconds with a bobbing, twisting head. Spion plays the supplied five-second GIF as a compact local muted MP4 once at screen center, seeking to server-measured playback age and disappearing at animation end regardless of sound length. Reduced motion uses a still Spion poster and a static Skibidi. Existing audience filtering, instance bounds and preview exclusions apply.

### Deepgram Nova-3 streaming

Set `TRANSCRIPTION_PROVIDER=deepgram` and `DEEPGRAM_API_KEY` in the ignored `.env`, and run `just update`. Keep your existing local Compose override to leave the local worker available. Settings → Admin → Conversation → Transcription provider switches between Local and API · Deepgram Nova-3 and saves the choice across restarts. A switch is rejected if the requested local worker is unavailable or the API key is missing. The app connects directly to Deepgram; no local GPU worker or Deepgram SDK is required. The environment provider is the initial default; the saved admin choice takes precedence. Use `COMPOSE_FILE=compose.yaml:compose.cloud.yaml` only for an API-only installation without a local worker. Existing local model selections and caches are retained.

Each Discord speaker has a separate Nova-3 WebSocket, with mono 16 kHz PCM and an explicit Dutch language by default. English and multilingual mode remain available through the conversation language control. Audio is processed in bounded memory and sent to Deepgram; audio and transcript text are not logged. Cloud processing incurs Deepgram API charges. At most 16 speaker connections run simultaneously, each with a 128-packet queue; account concurrency limits can be lower. Connections close after five seconds without incoming Discord audio, and failed connections back off for 15 seconds. Silence or continuous microphone noise can keep a connection active and billable.

Preliminary text appears with a Recognizing label and is replaced as recognition improves. Only completed utterances are stored in the live conversation and evaluated for triggers. Interim text stays in bounded memory, is available only through the authenticated live-transcript API, and never travels inside SSE events. Disconnecting or disabling recording cancels streams and clears partial text. Saved vocabulary hints are passed as individual Nova-3 keyterms, including multi-word phrases; editing hints updates active connections.

### Conversation API options

Settings → Admin → Conversation contains provider/model/language selection and Deepgram settings. Individual Vocabulary hint inputs sit under Keyterm Prompting. English (`en`), Dutch (`nl`) and Multilingual (`multi`) are available; multilingual maps to automatic language detection for the local provider. Existing newline/comma-separated hints load into individual inputs; saving preserves the shared hints setting used by local prompts and API keyterms. Keyterm Prompting can be disabled for the API without deleting the saved vocabulary. Local and API are exclusive providers: API failures never switch to local automatically.

Self-mute or server mute closes only that user’s API stream and removes their partial text immediately. Unmuting allows the next audio packet to start a stream once ten seconds have elapsed since the latest mute transition. Repeated notifications of the same mute state do not extend the cooldown. Other speakers continue normally.

API options include Smart Format, interim results, Utterance End (1000–5000 ms, requiring interim results), endpointing (0–5000 ms or disabled), keyterms, diarization (`latest`/`v1`), punctuation, profanity filtering, redaction, find/replace, acoustic search with confidence metadata beneath final messages, speech-start events, English-only dictation and numerals. Legacy Keywords is omitted because Nova-3 uses keyterms. Each control links to its official documentation. Saving API options persists them and restarts API streams. Defaults retain the previous behavior; enabling formatting, filtering or replacements can alter trigger text. Discord user attribution remains independent of diarization within a microphone stream.

Deepgram final-result deduplication follows recognized word timestamps within each speaker stream. Replayed final/flush results for the same audio do not create another chat message or trigger sounds twice, even when their surrounding audio-window durations differ. Repeated words spoken at later timestamps remain separate speech. Stale utterance-end events cannot finalize a newer utterance.

Runtime diagnostics distinguish expected HTTP rejections from server failures: normal 4xx responses are informational, rate limits are warnings, and 5xx responses are errors. Playback capacity retains its specific warning. Transcription drop warnings aggregate at most once every 30 seconds; the counter includes discarded audio packets, speech segments and failed streams, rather than measuring lost utterances. Audio arriving during a failed API stream's 15-second retry delay does not increment the counter for every packet. Deepgram diagnostics include HTTP rejection or abnormal WebSocket close codes without logging provider payloads, vocabulary, transcripts or credentials. Sender failures immediately stop their matching receiver and enter the same bounded retry delay.

PostgreSQL connection establishment tolerates a short database restart with up to six attempts, three-second connection timeouts and one-second gaps. After an established connection is lost, the next operation outside a transaction attempts a fresh connection with the same three-second timeout and restores session search settings. Failed writes and interrupted transactions are never replayed; deliberate shutdown stays closed. Recovery does not rerun schema initialization or job recovery. `/api/health` checks the database and returns HTTP 503 while it is unavailable, returning to HTTP 200 after recovery. Discord participant departure cleanup also handles recording being stopped, preventing an absent audio reader from crashing the voice WebSocket poller. Isolated Discord packet decryption or jitter-buffer losses can still occur during network interruptions; their presence alone does not trigger a voice reconnect.

### Music mode

In a playlist song's **Edit** dialog, drop or choose a local `.mp3` to replace its recording when saving. Uploads use existing playlist edit permissions, accept up to 100 MB within the configured import, source-duration and shared media limits, and verify the audio before saving. Names, artwork and song identity remain attached to the playlist song; already queued songs keep their recording. A changed playlist or lost access rejects the save and leaves the editor's draft selected for review.

Uploaded recordings use the existing music cache and storage inventory. Identical file contents share one immutable recording, retained across restarts. Local uploads are exempt from automatic music pruning because they cannot be downloaded again; admins can remove unreferenced copies through Storage's review workflow. Playlist, Likes and queue references continue to protect them. Missing uploaded files require another upload; playback never falls back to a different recording. A YouTube source can still be selected in the same dialog.

The Soundboard / Music switch above the sidebar account divider changes the mode for the whole server. Users need Music access and mode-switch permission to switch. Player controls and shared queue changes need music-control permission. These actions require presence in the bot's connected voice channel unless Use Geluidsman outside voice is granted; administrators follow the same rule. The three Music permissions are enabled by default and can be overridden in Admin permissions.

Music mode stops Discord soundboard playback, live transcription, speaking detection and all pending automatic sound triggers. Conversation and Actions remain accessible for creating, editing and enabling saved rules; those rules do not execute until Soundboard mode returns. Recording controls show the preserved preference but cannot start capture in Music mode. Soundboard and Video library remain accessible to create, import, cut, edit, organize and preview sounds locally. Sound cards cannot play through the bot in Music mode, and direct playback requests remain blocked by the backend. A mode change received from another browser preserves an open sound upload or edit draft. Active transcription API connections close. Music mode forces Discord self-deafen, including reconnections, and prevents undeafening until Soundboard mode returns. Switching back restores the preceding Soundboard deafen preference. Existing rules, enabled settings, provider and model selections are preserved. Returning to Soundboard allows its normal recording and action lifecycle to resume. Direct sound playback and stop-all APIs cannot interfere with Music mode.

Open Music to search YouTube by title/artist or paste a YouTube video/playlist or Spotify track/album/public-playlist link. Collection resolution runs as a bounded, cancellable background import; unavailable songs are reported and the remaining source order is preserved. Collection links open a destination dialog for the queue or an editable saved playlist. Search results have separate queue and library-save controls. Enqueueing does not start playback automatically: press Play when ready. The shared player offers pause, previous/next, seeking, shuffle, repeat and stop, alongside the existing volume and voice controls. Music is encoded to Discord as 384 kbps Opus at 48 kHz stereo; source quality still depends on the recording. The transport and seek controls stay centered in the music player. The timeline shrinks as the available width decreases, keeping song details, playback and voice controls side by side at desktop widths. The player uses a separate centered row only when those controls no longer fit; sidebar expansion is included in that decision. The connection bar keeps 22px horizontal padding at every viewport width. The master-volume speaker button sets the shared volume to zero and restores the last nonzero level known to the open app when pressed again; it uses master-volume permission and does not change Discord microphone mute. Remote volume changes refresh the slider through existing status events. Each transport button retains its own pending state, and different pending commands execute in order. Play/pause and seek progress leave unrelated controls, artwork and queue rows unchanged. Track details show the requester without duplicating paused or loading text; playback state stays on the transport controls. The queue icon immediately before master volume toggles a right sidebar across Music pages and other app pages. Its Queue tab separates Now playing, Next in queue and Next from the active playlist. Current-song cards show the requester without a playing, paused or loading label. The Recently played tab keeps the last 50 started songs, newest first, and lets voice participants replay or enqueue them. Music opens on Liked Songs. Its library and central pane fill the available viewport above a compact bottom player, with scrolling inside each pane and an optional queue on the right. Use the search bar or library directly; there are no separate Search/Playlists chips, empty discovery landing page, destination selector or page footer. Search URLs preserve the query for reload and browser history. Each playlist has a right-aligned title/artist search that filters only its displayed songs. Download retries sit beside the downloaded count, separated by a middle dot. Clear that filter to reorder; Play always uses the complete playlist. Add songs from search results or the queue. The library snaps directly to its artwork rail when space is limited and remains accessible. Search and Playlists retain their existing URLs; old queue URLs open the sidebar. Playlist covers use up to four safe artwork thumbnails in small paginated summaries without sending full song lists. Drag whole queue or playlist rows to reorder songs with a mouse, touch or pen; interactive controls do not start dragging. A floating row follows the pointer while neighboring rows animate into place. The keyboard drag control supports Space to pick up/drop, arrow keys to move and Escape to cancel. Playlist song rows have Play now and Add to queue buttons before their artwork. Play now interrupts the current song, inserts the selection next and preserves the remaining queue. Stop retains the queue. Queue rows show requesters and a horizontal three-dot menu with a searchable Add to playlist submenu, a separate Liked Songs action and Remove from queue. The submenu supports new playlist creation, membership checks, mouse hover, touch and keyboard navigation, opening beside the parent when space permits and within the viewport otherwise. Escape closes one menu level at a time. Adding to an editable playlist is also available outside voice. Queue songs cannot be edited. Playlist rows keep their existing save check/plus trigger; their three-dot menus contain only permitted Edit and Remove from playlist actions, without a duplicate Add to playlist entry.

Liked Songs is always the first library entry. The player uses a plus/check save menu for Liked Songs and server playlists, available without voice presence. Search, queue and history rows use the same cascading playlist picker with a separate Liked Songs action. Search rows share playlist play, add-to-queue, artwork, download-status and save controls; their three-dot menu also offers Add to queue and the cascading playlist picker. Playlist songs reveal a plus/check button immediately before their duration on row hover or keyboard focus; it stays visible while its save menu is open and is always available on touch screens. Playlist rows use a compact two-line layout with duration on the right and an inline download-status icon. Download progress and failure details appear on hover, keyboard focus or touch rather than taking up another text line. Recently played has equal top and bottom list spacing. A check means the song is liked or saved in a shared playlist. The searchable, paginated menu shows existing memberships, permits idempotent additions/removals only where editing is allowed, and can create a playlist containing the song. The side picker reserves a stable height during loading, membership changes and searches. It enters horizontally from its available side, stays inside the viewport and preserves keyboard and touch navigation. Reduced motion disables the entrance animation. Reopening validates the retained page; unverified choices stay hidden until the server confirms them. Likes are private to your account and persist across restarts; changes refresh only your own connected browsers. Each account can like up to 1,000 songs. Liked songs use the same bounded download cache, and playing or enqueueing them copies a snapshot into the shared player. Removing a like never changes an existing queue snapshot. Regular app playlists are visible to signed-in server members, with your playlists first after Liked Songs. The creator and administrators can edit a playlist by default. Allow others to edit permits other Music users to rename it and add, reorder or remove songs. Only the creator or admins can change that setting or delete the whole playlist. Each saved song has a horizontal three-dot menu with Edit and Remove from playlist; private Liked Songs offers the same editor and Remove from Liked Songs. The shared editor supports a local MP3 dropzone. Downloads opens that editor directly and asks which saved copy to change when several editable references exist. Edit changes its display name or individual YouTube source URL. Changing the source validates and pins that recording, removes its previous download when no other playlist uses it, and queues a replacement download. Changing only the name preserves its download and original Spotify matching title. Concurrent playlist changes require reopening the editor to avoid overwriting someone else's changes. Play starts a separate snapshot of the playlist immediately. Manually queued songs take priority after the current song, then playback continues through the remaining playlist. Starting another playlist replaces that playlist context and preserves manually queued songs. Add to queue copies the playlist into the manual queue instead. Source and name edits update matching upcoming entries from the selected saved collection, including its repeat cycle; current playback and independently queued recordings stay unchanged. Removed songs and deleted collections leave existing queue snapshots intact. Saved-origin references are retained for individual and bulk queue additions and reconciled on restart. Playlist summaries are paginated. Entering Music preloads Liked Songs, and deliberate pointer hover or keyboard focus prefetches playlist metadata and track lists; touch selection requests details immediately. An account-scoped memory cache retains up to 12 recent playlist details and three library pages, reuses pending requests and survives navigation within the app. Every activation validates against the server, including completed hover prefetches. Mutable headers, counts and songs stay hidden until confirmed; layout placeholders become visible after 180 ms and ready results appear immediately. Failed reads keep a visible Retry action, and access failures clear retained tracks. Edits, likes and live events invalidate or update the same cache, with older responses prevented from undoing newer saves. Logout, account changes and lost Music access discard it. Reloading the browser starts with an empty memory cache. These reads do not schedule audio downloads or alter playback prefetching.

Playlist songs download automatically into the persistent `data/music-cache` directory, including existing playlists on startup. Downloads keep the original compressed YouTube audio without another lossy encoding step; completed files are verified before becoming playable. Cached playback and seeking use local files, so they do not need a new YouTube stream URL. The playing song finishes downloading before its decoder starts, so seeking reuses the complete local recording. A song that is not downloaded yet briefly stays in the player’s loading state. Playlist rows show waiting, downloading, Downloaded or failed status; playlist editors can retry failed downloads. Failed items do not block the rest of the playlist. Interrupted downloads are discarded and retried on restart. The current song and next five upcoming queue entries are also retained and downloaded, even when they do not belong to a saved playlist. Moving, shuffling, skipping or clearing the queue updates that window. Removing the last playlist or active queue-window reference releases the cache entry.

The cache downloads up to two songs concurrently and reuses duplicate entries across playlists. Per-download byte reservations enforce the configured storage budget and free-disk reserve across active transfers. YouTube downloads use sequential 1 MiB HTTP ranges to avoid slow full-response transfers. Every range validates offsets, total size, response length and stable resource validators when supplied; truncated or changed recordings are rejected. Files still pass the existing media verification before receiving the Downloaded label. The playing song and up to five upcoming songs are prioritized ahead of the remaining playlist downloads. Playback can interrupt one background download to free a worker; the interrupted playlist download resumes later. All transfers share the existing two-worker, disk-space and source-duration limits. `MUSIC_CACHE_MAX_BYTES` defaults to 10 GB and is a migration input for the shared media limit together with `MAX_STORAGE_BYTES`. The existing 256 MB free-disk reserve and 10,000-song cache limit remain. Each download also obeys `MAX_IMPORT_BYTES` and the configured source-duration limit. When storage is full, remaining songs show a failure; review unused files in Admin Storage or increase the shared media limit, then retry. Cache files and manifests contain no expiring stream URLs or Spotify tokens. Actual download connections and redirects use the same private-destination protections as streaming.

Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the ignored .env file; SPOTIFY_MARKET defaults to NL. Credentials and access tokens stay on the server and are redacted from diagnostics. No Spotify account login is added. Spotify supplies metadata; YouTube supplies playback audio. Spotify matching searches the original title and artist without forcing an audio-only query. It compares title similarity, primary artist, recording version, remixer and duration, penalizes unrelated title words, and favors artist channels. Spotify album names are retained so known album suffixes can be distinguished from song titles. Free Download labels, credited artist prefixes and verified publisher suffixes are ignored for title scoring while recording-version checks remain intact. Ambiguous single-word titles get one additional Provided to YouTube query, with at most 40 candidates overall. At most two plausible generic Topic-channel results receive full metadata verification of their actual artist before acceptance. The duration window remains 8%, bounded to 3–35 seconds; longer/shorter alternate recordings still require a manual source choice. Unrequested mashups, live versions, remixes, edits and speed changes are rejected. If confidence is too low, the song reports that a recording must be selected manually instead of accepting an uncertain result. The chosen YouTube recording can be inspected or corrected through the playlist song menu’s Edit → Source; explicit corrections remain pinned during automatic rematching. Some Spotify public playlists are refused by the API because app credentials lack owner/collaborator access; use a YouTube playlist instead. Spotify development access requires its app owner to maintain Premium. Consult [Spotify's developer policy](https://developer.spotify.com/policy) and [playlist API restrictions](https://developer.spotify.com/documentation/web-api/reference/get-playlists-items); this is not an official Spotify audio-streaming integration.

Music uses the existing Discord connection, one FFmpeg decoder and the installed yt-dlp/JavaScript runtime, without another music server or audio files in the sound library. Metadata work is limited to two active extraction workers, 16 pending extractions and eight import jobs, with one active import per requester. Search returns at most ten songs; manual queues hold up to 500 songs, an independent active playlist context holds up to 1,000 songs, saved playlists hold up to 1,000 songs and each account can create 100 playlists. The configured source-duration and download-byte limits also apply. Live streams and unknown-duration recordings are excluded. YouTube availability and sign-in restrictions can still prevent a recording from playing; choose another recording when needed.

Mode, playlists, manual queue, active playlist snapshot, the last 50 played songs, current song, shuffle/repeat and playback position persist in PostgreSQL. Position checkpoints are saved every 15 seconds while playing and immediately on pause or graceful shutdown. Switching away from Music stops its decoder and retains the queue/position; switching back requires Play. Application restarts and actual voice disconnections also restore music paused. Brief Discord gateway interruptions preserve existing playback. An exhausted queue stays idle in Music mode, and there is no idle voice disconnect. Removing a song from either queue also removes it from the retained Repeat all cycle, including after restart; the saved playlist remains unchanged.


Music decodes up to ten seconds of audio ahead, waiting for five seconds before starting (or the complete remainder of a shorter song). The voice sender reads from this bounded PCM buffer without waiting for a slow network read. Music uses its own sender with one monotonic 20-millisecond clock. It reads the buffered PCM and completes 384 kbps Opus encoding before waiting for the packet deadline, so it does not compete with Discord's normal soundboard pacing loop. Packet spacing is measured between the starts of send operations, so normal packet encryption and send processing fit inside each 20-millisecond frame instead of extending every frame. Small timer delays recover against the original deadlines, with at least 5 milliseconds between send starts. A send operation exceeding the whole frame budget retains a 17-millisecond cooldown after completion. Lateness exceeding a whole frame rebases the clock instead of sending an unbounded catch-up burst. Pause, stop and disconnection invalidate pending sends; actual voice loss retains the current song paused.

Bounded numerical summaries report local send-call rate and active duration, accumulated drift from 50 frames per second, recent-window rate, gaps over 21/25/30/40 milliseconds, buffered-read/encode/send costs, timer oversleep, deadline lateness and rebases. They run through existing checkpoints, initially and approximately once per minute, with coalesced warnings when stall counters change. A sustained overall or recent-window rate below 49.5 warns even without individual 40-millisecond gaps. Pause and reconnection waiting are excluded. These measurements describe local scheduling and completed calls to discord.py; they do not confirm UDP delivery, remote jitter or listener playout. discord.py can also catch local socket errors internally. Timer oversleep includes OS scheduling and delays reacquiring Python's interpreter lock; it cannot alone distinguish those causes.

The former 17-millisecond minimum spacing left only 3 milliseconds to recover scheduler oversleep. Repeated 4–5-millisecond wakeup delays accumulated lateness and triggered deadline resets. A no-voice container probe reproduced 45.02 fps with no decoding or networking. A synthetic FFmpeg/384 kbps Opus workload ran at 45.31 fps before the fix. The final 90-second probe sent 4,500 frames at 49.9998 fps with 0.3 milliseconds accumulated drift, no deadline rebases and no inserted silence, despite mean timer oversleep of 3.73 milliseconds. Deterministic regressions cover sustained 4.7–13-millisecond oversleep, an hour of send/encode work, long stalls, cancellation, pause and reconnection. A clock-only stress probe with one CPU-bound Python thread improved from 31.62 to 49.96 fps. A 5-millisecond recovery floor gives the observed scheduler and interpreter contention room to recover without zero-spacing sends; sustained overload or longer OS stalls can still lose time. These are local pacing results, not a live Discord listening test.

If the buffer empties, it sends silence at the normal frame rate instead of blocking Discord's playback clock and bursting delayed audio afterward. A stream that remains stalled for 20 seconds fails with a diagnostic and follows the normal bounded retry policy. Server playback position counts song audio rather than inserted silence. Cached songs use the same buffered decoder and music remains 384 kbps Opus, 48 kHz stereo.

Admin console and container logs report safe Music failure categories with the playback stage, provider, stable source/YouTube IDs, HTTP status when known and FFmpeg exit code when available. Categories distinguish removed/private recordings, country or age restrictions, sign-in requirements, rate limits, network timeouts, blocked destinations, unsupported formats, decoder failures, early endings and buffer stalls. FFmpeg diagnostics are read continuously into a bounded window and classified; raw provider responses, raw decoder stderr, signed media URLs and tokens are never logged. These details apply to new failures after this update; older generic errors cannot be reconstructed. A separate Music decoder cleanup summary records the process ID and whether cleanup found a running process (`requested_stop`), a normal exit (`completed`) or a pre-existing nonzero exit (`unexpected_exit`). discord.py's subsequent “terminated” messages are cleanup notifications, including expected forced termination on pause, seek, skip or shutdown; a negative exit code after requested cleanup alone does not establish a playback failure. Natural completion and unexpected decoder exit are tested independently. An early normal exit can still fail the existing duration check.

Music pane widths can be changed by dragging their vertical dividers or focusing a divider and using Left/Right, Home or End. Double-click a divider to restore its default width. Widths are remembered in the browser. During dragging, limits are measured once and width changes are applied directly to the affected panes once per animation frame; application state and stored preferences update on release. Escape restores the preceding width. The expanded library is 200–360 pixels wide. Dragging below its minimum has resistance before snapping directly to the 64-pixel artwork rail; expanding the rail also snaps directly to the minimum expanded width. Limited viewport space uses that same rail. Music locks the document and outer layout against user and automatic scrolling while each pane scrolls internally. Wheel and single-touch scrolling over the connection bar or pane gaps is suppressed; pane, dialog and dropdown scrolling remains available, and Soundboard uses the same pane scrolling behavior. Settings uses the same fixed outer layout, independent pane scrolling and remembered navigation width. The main sidebar also collapses automatically on smaller screens, with a manual collapse/expand button above the audio-mode switch on desktop. Player commands update their own controls and reuse unchanged library and queue data without disabling or replacing panes. Shuffle updates its button immediately and reorders affected queue rows. Seeking holds the chosen position until the server confirms it, coalesces repeated seeks while a request is pending, and keeps newer slider input visible through unrelated status updates.

Dialog Enter activates Save in edit dialogs and Delete in delete confirmations, regardless of the focused control. Required fields, disabled actions and in-progress operations remain enforced; multiline editors and open selectors retain their own Enter behavior.


## Loading, freshness and retained navigation

Save-menu choices and song membership are prepared on short pointer intent or keyboard focus. Touch opens and validates directly. Actions and Conversation prepare authorized rule/status reads independently and share the member directory with editing dialogs. Audit prepares filter options and the initial query; Hall prepares only Today and Most played. General, Fun and Conversation settings prepare their read-only data. Opening an emoji-containing editor loads the build-versioned catalogue; editor navigation intent loads code without downloading or playing audio/video. Waveforms are bounded to eight source/media-version pairs, with server-side version checks.

Mutable responses use one account/access-scoped memory store. The existing playlist and Permissions caches are adapters over it. There are at most four running shared reads, two speculative reads and eight queued speculative reads; visible requests take queue priority. Playlist detail/library caps remain 12/3, permission pages remain capped at five with the first retained, and other page resources are capped at 48 idle entries. Active readers and pending work can temporarily exceed a group cap. Navigation memory is capped at 64 entries. It retains searches, filters, selected permission users, periods and pane scroll positions without treating their results as fresh.

For eligible GETs, the backend authorizes and produces the current representation before comparing its account/query-scoped ETag. A matching conditional response permits reuse; otherwise the new body replaces it. APIs continue to use `private, no-store`, with no persistent browser data cache. Neither a short lifetime nor a connected event stream establishes freshness. Cached mutable content never appears while a new activation or required recovery validation is pending or failed. Routine conditional checks preserve already-mounted confirmed content; known invalidation hides only affected content until confirmed. Music keeps existing playlist headers, artwork and rows mounted but hidden, inert and excluded from the accessibility tree during required activation or invalidation validation, preserving their layout and scroll without displaying old values. Playlist hero, library and track skeletons follow the corresponding layout and appear after 180 ms. Sidebar artwork uses the independently confirmed library metadata; the Liked Songs count uses the shared likes summary regardless of the selected playlist. Focus and visibility events within the same browser frame share one validation; a new blur/focus or reconnect still validates again. Delayed decorative skeletons are hidden from assistive technology; loading status is announced and reduced motion is respected. Manual settings drafts and unfinished numeric edits survive remote refreshes; failed manual saves retain their drafts. Partial save responses are followed by validation instead of being merged with old metadata.

Dashboard state is split into interface, sounds, library, source editor and Fun reads; the former 15-second full-state poll is removed. The existing single event connection carries scoped identities and server epoch/revisions. Music playback progress and worker runtime changes do not invalidate library metadata, rules or settings. The visible Conversation settings tab checks worker runtime every two seconds independently of configuration. Storage review revisions exclude unrelated playback and connection updates. Mutations and the existing authenticated event stream update or invalidate affected resources, structurally sharing unchanged entities. Settings drafts retain edited fields and adopt confirmed changes to untouched fields with a conflict notice. Responses invalidated in flight cannot replace newer confirmed writes. Reconnection and browser focus validate again, and overflowing server event queues explicitly request a refresh. Transcription status GETs inspect worker state without switching models, closing streams or persisting settings. Audit GETs filter expired rows without deleting them; the existing cleanup loop handles physical retention.

These guarantees match the server state read during validation, then incorporate delivered updates; they do not provide instantaneous consistency across clients or an atomic snapshot across separate endpoints. Discord directory validation performs a fresh Discord fetch, but Discord can change immediately afterward, and directory-only Discord changes without a voice/event notification are picked up on the next activation or focus. Out-of-band database edits do not emit app events. Storage totals reflect the authoritative application ledger; external filesystem edits retain the documented ten-minute reconciliation limit.


## Shared downloads and media storage

The Downloads button below the sidebar mode control opens `/downloads`. It combines music recordings, source imports and queued channel items into Active, Waiting, Needs attention and Completed. Filters, search, expanded groups and pagination survive navigation. Completed defaults to three recent available assets; View all opens paginated results. Progress uses measured transferred bytes; unknown totals and processing remain indeterminate, and approximate totals are labeled. Retry, retry all, cancellation, recording selection and library links follow current permissions. Shared recordings download once, including songs that resolve to the same recording, and aliases survive restart. Cancelled background music stays paused after restart until retry; explicit playback can fetch it again. Shared music cancellation is restricted to administrators.

Settings → Admin → Storage shows actual file usage by Music, Source videos, Sound clips and Other media, with host disk free space and active reservations shown separately. The shared `media_max_bytes` setting initializes once from the effective legacy `MAX_STORAGE_BYTES` plus `MUSIC_CACHE_MAX_BYTES`; optional `MEDIA_MAX_BYTES` supplies the initial value. Subsequent changes use General settings. Legacy settings clients cannot replace this value. Lowering the cap never deletes existing files. Music, imports, conversion, extraction and uploads use shared reservations and the existing disk reserve; the existing music worker count, playback priority, next-five prefetch and automatic pruning remain.

The searchable inventory defaults to 50 items, largest first. Expand an item for its physical files and protection reasons. Review is required before **Remove downloaded files**. Removal rechecks a version token, references, authorization and active use, and reports partial filesystem failures. Saved playlists, private Likes, queued/current playback, linked source videos, sound files and active operations stay protected. Removing an eligible source bundle keeps its library entry and offers Download video. Deleting library entries is a separate workflow.

Open editors protect their source through the existing authenticated event connection. A disconnected editor keeps a 60-second grace period; it must reconnect, acquire protection and confirm its media version before resuming. Drafts stay mounted while validation is unavailable. Older connected browsers without lease support block source cleanup until refreshed. Reconnection, focus and navigation trigger current validation, with delayed skeletons and no stale-while-revalidate rendering. Cleanup dialogs reject changed reviews, and permissions/account changes clear private retained data.

Last use is recorded for future successful sound/music playback, source editing and browser media requests; older unknown history is shown as Not recorded. A media request indicates access, not proof the entire recording was played. Synchronization is bounded by event delivery and authoritative read latency, not instantaneous across clients. Direct external file/database edits do not publish app events; inventory measures them on the next read, while download admission retains the existing periodic storage-ledger reconciliation policy. Video attempts interrupted by restart remain retryable; completed media and PostgreSQL data are preserved by normal Compose updates.

Downloads and Storage validate their page summaries independently from filtered results. Filter changes retain the controls, headings and result-area height while hiding unconfirmed rows. Fresh query responses can update the same confirmed summary resource when no newer summary validation has superseded them; focus, reconnect and live invalidations still revalidate both. No stale rows are retained during filtering.


Downloads uses consistent columns across group headings and rows, including rows with different permitted actions. Retry uses the shared mutation invalidation once, keeps unaffected row and artwork elements mounted while hiding unverified values, and moves rows after the server confirms the new group. Delayed placeholders cover the retained layout while validation runs; errors discard the visible results. Short movement animations respect reduced motion. No optimistic download status, new polling or additional event connection is used.

**Use Geluidsman outside voice** replaces Always see live conversation and Play sounds outside the voice channel. It permits manual sound playback, music and queue controls, mode switching and live transcripts without joining the bot’s channel; the corresponding action permissions still apply. It is off by default, including for protected administrators. The versioned migration preserves explicit grants from either old permission, keeps an existing explicit new value, and removes the obsolete keys. Queue and mode mutations recheck current permissions after waiting for their execution lock.

Read requests interrupted by live-connection recovery may retry once within the same authenticated account and access scope. Reject obsolete responses before rendering or publishing them. Do not replay mutations or carry a read across logout, account changes or permission changes. A routine initial SSE refresh must not produce a misleading session-error toast.


Routine validation and unchanged responses preserve mounted content, artwork, menus, drafts, focus and scroll. Search rows use the playlist play, queue, save and download-status controls. Playlist membership responses and events reconcile the existing chooser cards, including their shared artwork, without rebuilding the chooser or disabling unrelated controls. Download byte progress and successful loudness measurements carry scoped authoritative updates with unchanged group counts; shared usage values carry server revisions. Known group changes, failed validation, access changes and reconnect recovery still require current authorized reads. General, Fun and transcription option saves reconcile confirmed responses without a loading reset.
