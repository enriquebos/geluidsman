# Geluidsman project rules

## Working agreement

- Follow this file for every change. Later user instructions take precedence.
- Use Python with Poetry, strict Ruff checks and formatting, and React/TypeScript.
- Authored code must contain no comments or docstrings. Explain behavior in documentation.
- Keep Windows and Linux support through the project's own Docker images and Compose stack.
- Cache dependency layers and model/media downloads. Use PostgreSQL and preserve existing accounts, media, permissions and import jobs.
- Store secrets exclusively in ignored .env files; never expose them in logs, API responses, browser bundles or Git. Maintain .env.example without credentials.
- Use server 1352422295402057759 only. No self-bot, cross-server features or automatic joining of voice during verification.
- Keep port 8687 and user-configured public URL/OAuth redirects. Do not change credentials or router settings without a request.
- Do not add unnecessary startup repairs, migrations, dependencies or platform-specific PowerShell launch scripts.

## UI consistency

- Use the shared themed SearchSelect dropdown, as used for the transcription model. New dropdowns must not rely on OS-rendered option menus. When editing an older dropdown, migrate it to this shared control.
- Dropdown menus use the dark site surface, rounded borders, full-width selection/hover highlighting, readable text and cursor:pointer on clickable items.
- Keep chevrons inset from the right edge, fixed in size, with enough text padding to avoid overlap. Long names truncate inside the field; menu items wrap where needed.
- Menus must stay within the viewport and above dialogs, without being clipped by scroll containers. Support touch, search and keyboard navigation.
- Multi-user selection uses checkboxes within one searchable dropdown. Do not duplicate users as separate checkboxes or chips beneath it. Include every human guild member and merge voice participants by Discord ID.
- Inputs, checkboxes, switches, dialogs, date/time controls and focus indicators must match the site theme. Respect disabled states and permissions.
- Leave clear spacing between titles, sections and controls. Avoid overlapping emoji controls, volume labels and field text. Sidebar labels must not wrap unnecessarily.
- Personal settings apply automatically without a save button; the account stays in the sidebar. Position toasts at the top right below the visible top bar; use the top of the viewport when that bar has scrolled away.
- Prefer animated, dismissible toasts for confirmations and routine errors. Keep progress and failed-item details inline when they need persistent attention. Do not use browser alert/confirm/prompt dialogs.
- Dialogs close with Escape. Escape first closes an open dropdown. Enter submits the dialog's primary action, including deletion; honor validation, busy states and disabled actions. Do not submit while typing in a multi-line editor or selecting a menu option.
- Preserve page/tab URLs and browser back/forward/reload state. Keep the admin console mounted when changing tabs; scrolling up must stop following logs.
- Use accessible names, roles, focus behavior and readable text. Respect reduced motion. Verify desktop and touch layouts; retain Firefox context-menu compatibility.

## Product rules from this chat

- Permissions are enforced by the backend and reflected immediately without page reloads or refetching the entire admin user list. Permissions UI uses switches, grouped descriptions and immediate updates.
- Permission rows identify Default versus Custom override and support filtering to overrides. Personal settings panels span the full page width. Sidebar has no workspace label and brand bottom margin is 33px. Exclude voice channel 1355614484797980723 from selection and backend connections.
- Channel import and recording-control permissions are disabled by default for ordinary users. Values equal to inherited defaults are not custom overrides. Recording switches must be visibly disabled without recording-control permission. Sidebar BETA and connected-user labels change only at sidebar-width breakpoints.
- Protected .env administrators cannot lose admin access; only they may change their other permissions for testing. Conversation and Actions page access are enabled by default for ordinary users; explicit denials remain enforced. Recording controls cannot override a protected deafen action.
- Enabled user-specific Actions override everyone rules for the same event and matching participant, including during cooldown or failed execution. Show affected rules in the action dialog; recheck precedence before delayed execution.
- Action/trigger items use compact rows, with delay and cooldown on their own line. Resolve speakers through the guild directory, including users outside voice. Override warnings show affected speaker names for the edited rule, not creator names. Hide queue counters on these pages; coalesce dropped-work warnings in the application console without transcript or audio content.
- Conversation and Actions use matching When / Who / Then / Timing dialog sections. Shared triggers can be edited by authorized users. Use multiple individual word/phrase inputs.
- Conversation sound triggers are unique globally per selected sound, across all users. Additional phrases belong in the existing trigger. Match punctuation-insensitively and recheck creator permissions before execution.
- Live transcripts require voice-channel presence unless the default-off Always see live conversation permission is granted. Show both inline conversation and a floating chat button; disable its button without an active accessible recording session.
- Keep transcription local, audio in bounded memory, and transcript text out of logs and SSE payloads. No recording notices in voice chat. Conversation is live-only; disabling recording clears transcripts. Preserve literal *Raren geluiden* fallback and Conversation BETA label.
- On startup, disconnect/reset Discord voice state before reconnecting to the reported existing channel or the persisted last successful connection. Wait for a reported leave before reconnecting when Discord still reports the bot in voice. Explicit Disconnect clears the restart target; graceful shutdown preserves it. Disconnect voice first during shutdown. Do not join voice during verification. Do not add an idle disconnect timeout. Bound connection handshakes and reclaim stalled disconnected voice clients after a recovery grace period; retain automatic retry targets until explicit disconnect. Speaking actions work independently of transcription when the bot is undeafened.
- Manual soundboard playback requires presence in the bot’s voice channel unless the default-off outside-channel playback permission is granted. Automatic Conversation and Actions triggers do not require creator presence or outside-channel playback permission: validate the triggering human participant’s guild membership, channel access and active-channel eligibility instead. Actions leave events retain eligibility through their source channel after departure. Delayed triggers recheck participant eligibility, creator permissions/membership/channel access, enabled rules, session validity and Actions precedence. Sound cards play to Discord on click; preview is separate and keeps its icon unchanged. Support right-click editing in standard and compact modes.
- Soundboard sections may overlap: Pinned, Frequently used, Top sounds, All sounds. All sounds includes every sound, newest first. Frequently used and Top sounds are capped at 20 and ranked by persistent all-time successful play counts, independent of audit retention.
- Keep compact emoji/name centered, with space for long names; wrap long compact names onto up to two lines, including unbroken words; hover controls may overlay content. Pins should update smoothly without a full reload.
- Sound names max out at 255 characters. Tags are reusable/createable. Upload supports .ogg/.mp3 and leaves the name empty. Cut new sounds at 100% without a volume slider. Long-sound creation/upload permission is off by default: granted users may create sounds up to 600 seconds and upload up to 100 MB; others retain the configured standard duration and 20 MB upload limit.
- Sound editing shows the full 1000% slider range, limiting users without boost permission to 300%. Preview belongs below the volume slider; keep limit labels clear.
- Normalize newly uploaded and extracted sound audio to a -16 LUFS baseline with a -2 dB true-peak ceiling and a maximum 24 dB boost. Preserve dynamics, silence and exact PCM duration. Apply normalization before encoding the browser preview, outside the playback path. Existing sounds have been normalized and reset to 100%. Remove one-off maintenance tools after validation; never normalize existing media on startup.
- Waveform dragging moves the whole selection with unchanged duration; fast dragging uses normal scale, slow dragging zooms, and zoom remains until release. Keep handles visible, hide scrollbars and play from selection start with Space.
- The emoji picker includes standard and server custom emoji, left-side categories and enough width. Do not add skin-tone controls.
- Video collection is newest first, 50 per page, with bottom pagination and Page x of y. Audit uses pagination and searchable user/sound/result filters. Failed imports have details, Retry and Ignore.
- Audit rows are expandable only with extra details; omit playback IDs. Keep leaderboards and played-count graphs responsive.
- Sidebar navigation groups are Play, Create and Manage; show the active channel above connected humans. Connection status names the channel and displays muted/deafened state; connecting, reconnecting or muted icons are orange. Playback chips show progress and volume retains an accessible Bot volume name without a visible label. Active sounds glow for all users; compact hover controls hide until hover or keyboard-visible focus, without a sticky pointer-focus state.
- Connection controls replace the top bar across pages. Account and logout belong at the sidebar bottom; connected human voice participants replace the sidebar note. Mute/deafen controls stay fixed on the right. Active playback chips use horizontal space first without duplicate + summaries.

## Performance and verification

- New features must perform well: bound queues, buffers, payloads and expensive work. Keep database, inference and gateway callbacks off the mixer/playback path.
- Reuse shared components and authorization helpers. Parameterize SQL, avoid shell interpolation, and guard downloads against private destinations.
- Prefer targeted state updates, optimistic reversible actions, cached/static data and batched independent requests. Avoid redundant refetching, polling and event subscriptions.
- Test meaningful backend authorization, persistence, uniqueness/concurrency and error paths. Run affected browser tests, frontend build, Poetry validation, strict Ruff, formatting and comment/docstring scans.
- Verify changes, then update the running Compose stack by default unless the user explicitly pauses deployment. Preserve persistent data and use graceful restarts. Report material limitations honestly; do not claim live voice validation unless it happened. Do not commit or push unless requested.

- Attribute automatic playback and Hall of shame counts to the triggering Discord participant, including people without app accounts; keep creator permission checks and record creator separately. Fun effects are independently toggled admin settings. Deliver Flashbang, Vine boom and SUS only to app viewers in the bot’s active voice channel, across all their open devices. Use server-measured elapsed time, never compare device wall clocks. Center The Rock in the viewport. Bind Flashbang, Vine boom and SUS to protected sound IDs, never names; browser previews do not trigger effects. DVD is silent and independent, with a persistent 0.25–5× speed control to the left of its switch. SUS floats a red crewmate left to right. Keep visual effects bounded, pointer-transparent and respectful of reduced motion.


Goose and Kirby are independent, default-off Admin Fun settings. Goose wanders independently across the app, occasionally showing cursor interest, and hides on touch-only devices. Kirby counts authorized manual playback attempts, including capacity rejections, across each account’s devices: default 20 within 5 seconds, configurable from 1–100 attempts and 1–60 seconds. The threshold-reaching request pauses that account’s manual playback for five seconds and inhales its soundboard cards. Existing playback, previews, automatic triggers and other accounts are unaffected. Repeated requests do not extend the pause. Disabling Kirby clears pauses; restarting clears transient counters. Use account-filtered SSE and monotonic elapsed timing, bounded buffers, pointer-transparent visuals and reduced-motion behavior.


## Frontend deployment updates

Every Vite production build gets a unique ID embedded in its JavaScript and `frontend/dist/build.json`. Deploy the complete frontend output with its backend; keep that metadata with the build. Backend restarts reuse the same build ID. Rebuilding locally requires restarting the backend serving that output. Vite development mode does not show production update notices.

HTML uses `Cache-Control: no-cache`. Only generated content-hashed assets listed in the build metadata receive `public, max-age=31536000, immutable`; other static assets are revalidated. Private APIs and media remain uncached.

The existing authenticated SSE connection reports the serving build on every initial connection and reconnection. Existing state refreshes also compare IDs when returning to a visible tab. A mismatch shows one persistent, accessible update banner. Missing or malformed version information does not interrupt the app. The notice remains until reload; it never forces a reload or clears storage, cookies, preferences or sessions. Refresh keeps the current path, query and hash, and asks before discarding tracked unsaved editors, uploads or application settings. Finish active work before choosing to refresh.

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
