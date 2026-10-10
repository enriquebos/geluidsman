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
- On startup, recover only an existing voice state reported by Discord; never join a saved channel automatically. Disconnect voice first during shutdown. Do not join voice during verification. Do not add an idle disconnect timeout. Bound connection handshakes and reclaim stalled disconnected voice clients after a recovery grace period; retain automatic retry targets until explicit disconnect. Speaking actions work independently of transcription when the bot is undeafened.
- Manual soundboard playback requires presence in the bot’s voice channel unless the default-off outside-channel playback permission is granted. Automatic Conversation and Actions triggers do not require creator presence or outside-channel playback permission: validate the triggering human participant’s guild membership, channel access and active-channel eligibility instead. Actions leave events retain eligibility through their source channel after departure. Delayed triggers recheck participant eligibility, creator permissions/membership/channel access, enabled rules, session validity and Actions precedence. Sound cards play to Discord on click; preview is separate and keeps its icon unchanged. Support right-click editing in standard and compact modes.
- Soundboard sections may overlap: Pinned, Frequently used, Top sounds, All sounds. All sounds includes every sound, newest first. Frequently used and Top sounds are capped at 20.
- Keep compact emoji/name centered, with space for long names; wrap long compact names onto up to two lines, including unbroken words; hover controls may overlay content. Pins should update smoothly without a full reload.
- Sound names max out at 255 characters. Tags are reusable/createable. Upload supports .ogg/.mp3 and leaves the name empty. Cut new sounds at 100% without a volume slider. Long-sound creation/upload permission is off by default: granted users may create sounds up to 600 seconds and upload up to 100 MB; others retain the configured standard duration and 20 MB upload limit.
- Sound editing shows the full 1000% slider range, limiting users without boost permission to 300%. Preview belongs below the volume slider; keep limit labels clear.
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
