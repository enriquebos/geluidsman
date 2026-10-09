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
- Prefer animated, dismissible toasts for confirmations and routine errors. Keep progress and failed-item details inline when they need persistent attention. Do not use browser alert/confirm/prompt dialogs.
- Dialogs close with Escape. Escape first closes an open dropdown. Enter submits the dialog's primary action, including deletion; honor validation, busy states and disabled actions. Do not submit while typing in a multi-line editor or selecting a menu option.
- Preserve page/tab URLs and browser back/forward/reload state. Keep the admin console mounted when changing tabs; scrolling up must stop following logs.
- Use accessible names, roles, focus behavior and readable text. Respect reduced motion. Verify desktop and touch layouts; retain Firefox context-menu compatibility.

## Product rules from this chat

- Permissions are enforced by the backend and reflected immediately without page reloads or refetching the entire admin user list. Permissions UI uses switches, grouped descriptions and immediate updates.
- Protected .env administrators cannot lose admin access; only they may change their other permissions for testing. Ordinary users need explicit Conversation/Actions page access. Recording controls cannot override a protected deafen action.
- Conversation and Actions use matching When / Who / Then / Timing dialog sections. Shared triggers can be edited by authorized users. Use multiple individual word/phrase inputs.
- Conversation sound triggers are unique globally per selected sound, across all users. Additional phrases belong in the existing trigger. Match punctuation-insensitively and recheck creator permissions before execution.
- Keep transcription local, audio in bounded memory, and transcript text out of logs and SSE payloads. No recording notices in voice chat. Conversation is live-only; disabling recording clears transcripts. Preserve literal *Raren geluiden* fallback and Conversation BETA label.
- On startup, recover only an existing voice state reported by Discord; never join a saved channel automatically. Disconnect voice first during shutdown. Do not join voice during verification. Do not add an idle disconnect timeout. Speaking actions work independently of transcription when the bot is undeafened.
- Playing sounds requires presence in the bot’s voice channel unless the default-off outside-channel playback permission is granted; automatic triggers obey the same rule. Sound cards play to Discord on click; preview is separate and keeps its icon unchanged. Support right-click editing in standard and compact modes.
- Soundboard sections may overlap: Pinned, Frequently used, Top sounds, All sounds. All sounds includes every sound, newest first. Frequently used and Top sounds are capped at 20.
- Keep compact emoji/name centered, with space for long names; wrap long compact names onto up to two lines, including unbroken words; hover controls may overlay content. Pins should update smoothly without a full reload.
- Sound names max out at 255 characters. Tags are reusable/createable. Upload supports .ogg/.mp3 and leaves the name empty. Cut new sounds at 100% without a volume slider.
- Sound editing shows the full 1000% slider range, limiting users without boost permission to 300%. Preview belongs below the volume slider; keep limit labels clear.
- Waveform dragging moves the whole selection with unchanged duration; fast dragging uses normal scale, slow dragging zooms, and zoom remains until release. Keep handles visible, hide scrollbars and play from selection start with Space.
- The emoji picker includes standard and server custom emoji, left-side categories and enough width. Do not add skin-tone controls.
- Video collection is newest first, 50 per page, with bottom pagination and Page x of y. Audit uses pagination and searchable user/sound/result filters. Failed imports have details, Retry and Ignore.
- Audit rows are expandable only with extra details; omit playback IDs. Keep leaderboards and played-count graphs responsive.
- Connection controls replace the top bar across pages. Account and logout belong at the sidebar bottom; connected human voice participants replace the sidebar note. Mute/deafen controls stay fixed on the right. Active playback chips use horizontal space first without duplicate + summaries.

## Performance and verification

- New features must perform well: bound queues, buffers, payloads and expensive work. Keep database, inference and gateway callbacks off the mixer/playback path.
- Reuse shared components and authorization helpers. Parameterize SQL, avoid shell interpolation, and guard downloads against private destinations.
- Prefer targeted state updates, optimistic reversible actions, cached/static data and batched independent requests. Avoid redundant refetching, polling and event subscriptions.
- Test meaningful backend authorization, persistence, uniqueness/concurrency and error paths. Run affected browser tests, frontend build, Poetry validation, strict Ruff, formatting and comment/docstring scans.
- Verify changes before deploying. Report material limitations honestly; do not claim live voice validation unless it happened. Do not commit or push unless requested.
