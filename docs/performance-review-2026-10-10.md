# Performance review — 10 October 2026

The conversation/chat scrolling fixes and approved proposals 1–5 and 8 are implemented. Proposals 6, 7 and 9–11 remain unimplemented. Measurements used read-only production queries and synthetic audio, without joining voice or sending microphone audio for inference.

## Measurements

The current dataset contains 301 videos, 63 sounds, 6,326 audit rows, 11,968 caption cues and 309 import jobs. Five warm samples were measured inside the app container; these are operation timings, not end-to-end HTTP percentiles.

| Operation | Median | Relevant size |
|---|---:|---:|
| Media directory size scan | 773.07 ms | 1,982,665,465 bytes |
| Load all video metadata | 2.62 ms | 162,730 JSON bytes |
| Load sounds and play counts | 1.75 ms | 33,067 JSON bytes |
| Load import jobs | 1.84 ms | 24,792 JSON bytes |
| Load channel batches | 0.43 ms | 574 JSON bytes |
| Eight concurrent sounds, mixer frame | 0.032 ms median; 0.035 ms p95 | 20 ms frame budget |

The sound-count aggregate uses a sequential scan and currently completes in 0.678 ms. The mixer test used generated PCM silence and 500 frames; it excludes encoding, disk contention, DAVE and network delivery. Neither result justifies an urgent rewrite of the mixer or count query.

## Proposals for yes/no decisions

1. **Replace repeated directory scans with tracked media totals. High priority.** `app/media.py:used_bytes`, `summary` and `import_job` repeatedly walk every file. Summary caches totals for only five seconds. Some import completion checks call the scan directly in an async function, blocking the event loop. Track validated revision sizes, update totals on add/delete, reconcile outside the event loop, and preserve atomic reservations so concurrent uploads cannot overshoot storage limits. Expected benefit: eliminate most measured 773 ms scans and heartbeat/request stalls. Main risk: drift after externally changed files, addressed by reconciliation.

2. **Move synchronous PostgreSQL work out of async handlers, using bounded concurrency. High priority.** `app/auth.py:current`, `app/main.py:state/play/stop` and `app/media.py:import_job` call synchronous DB methods on the event loop. `app/db.py` uses one connection guarded by an RLock, so imports and requests serialize. Use a bounded DB executor first; consider a small pool with explicit transaction ownership after profiling. Continue reading permissions on every authenticated request. Main risk: transaction correctness and deadlocks if existing connection sharing is changed carelessly.

3. **Batch caption inserts. High priority during imports.** `app/db.py:save_source` makes two SQL calls per cue, while `app/postgres.py:executemany` itself loops over individual executions. Stage cue rows and insert/search-index them in batches or with COPY inside the existing atomic revision transaction. Thousands of captions currently create thousands of round trips. Preserve rollback, cue identity, search accuracy and SQLite tests. This also reduces the duration of the shared DB lock.

4. **Share one authenticated SSE connection per browser tab. High priority with multiple visitors.** App, ConversationPage, ConversationWidget and each ConversationChat create independent EventSource connections. An active Conversation page has four; opening floating chat adds a fifth. `app/events.py:stream` authenticates each queue iteration, including global playback-progress events sent twice per second. Share one event bus, dispatch only needed subscriptions, and retain immediate session/permission enforcement. Expected benefit: fewer connections, auth reads and duplicate refreshes without caching stale permissions.

5. **Share an incremental transcript store between inline and floating chat. Medium/high priority.** Each chat separately requests the latest 100 messages on each finalized transcript event, merges/sorts the entire loaded history and renders it. Add an after-cursor API, fetch only new messages, and share results per session between both views. Keep transcript content out of SSE, recheck read permission and erase inaccessible sessions immediately. Main risk: cursor ordering, deduplication and reconnect gaps.

6. **Fetch library pages on demand and narrow full-state polling. Medium priority.** `app/main.py:state` returns all sources and sounds regardless of page. App requests it every 15 seconds even while healthy SSE is connected. Video pagination currently happens after receiving all 301 videos. Video metadata alone is 162.7 KB per response. Return paged video metadata/counts, load only data the route needs, and use a reconnect/fallback refresh rather than unconditional full polling. Preserve search and globally overlapping sound categories.

7. **Reduce UI work and virtualize long histories. Medium priority; measure before choosing thresholds.** Conversation keeps every loaded message in memory/DOM; AdminPage renders up to 2,000 multi-line console entries. App rebuilds filtered arrays, tags and playing sets on unrelated status changes; each video card scans all clips for its count. Memoize stable derived values, precompute source counts and introduce measured-height virtualization for long chat/console lists. Preserve scroll anchoring, keyboard access, screen-reader behavior and variable-height messages. Current 63-sound scale is modest, so sound-card virtualization is not urgent.

8. **Split editor/admin routes out of the initial JavaScript bundle. Medium priority for startup.** App statically imports route components, including Editor and WaveSurfer. Current main JS is about 418 KB uncompressed / 125 KB gzip; emoji data is already lazy-loaded. Lazy-load heavy routes with useful loading states. Main risk: initial navigation fetch delay, which can be reduced through idle prefetch. Avoid reimplementing the already lazy emoji loading.

9. **Enable carefully scoped media caching. Medium priority for repeat visits.** Middleware overwrites all API responses with private,no-store, including media routes. Revision-based thumbnail/video URLs and stable previews are fetched again instead of reused. Consider private browser caching keyed by revision, while keeping auth, transcripts and sensitive JSON uncached. Main tradeoff: cached media remains on the user's device until expiry; cached playback must not bypass current server authorization or hide edited revisions.

10. **Avoid rescanning audit history for sound counts as it grows. Low priority today.** `app/db.py:clips` groups all successful sound.play audit rows each time the sound list is returned, although leaderboard activity totals already exist. Maintain per-sound/per-user counters transactionally, or add a measured partial covering index first. The measured query is only 0.678 ms now; benchmark larger data before taking on counter migration/reconciliation complexity. Preserve all manual and automatic sound-play accounting.

11. **Measure transcription stage latency before changing recognition settings. Investigation first.** Packet draining, per-speaker VAD and segment handling run in the 20 ms conversation monitor; model inference is already in a separate worker with bounded queues and batch support. Add aggregate queue-age, preprocessing, inference and delivery percentiles plus event-loop lag, without transcript/audio logs. If packet processing is a measured bottleneck, move it to a bounded dedicated processor. Do not change model, beam size or speech segmentation solely on assumption; that can affect Dutch accuracy.

## Existing strengths and limits

Playback progress uses targeted events rather than full state updates, import/download queues are bounded, eight sounds are mixed in a single stream, model inference is isolated, the emoji dataset is loaded lazily, permission changes are immediate, and hidden-tab App refreshes are suppressed. These should be preserved.

No live Discord voice or recognition benchmark was performed. Five warm database samples and a synthetic mixer benchmark cannot establish production p95 latency under concurrent imports. Recommended order: 1–4, then 5–6, then profile 7–11 against agreed workloads.


## Implemented results

- **1 — Tracked media totals:** each committed revision has a measured size; staged quota checks, serialized writes and removal maintain the running total. Initial scanning and ten-minute reconciliation occur off the event loop. Externally modified files are reconciled periodically. Atomic saves complete safely during cancellation.
- **2 — Bounded database workers:** async authentication, API, import and trigger operations use four worker slots. Transactions retain the connection lock; permission reads remain fresh on each authenticated request. Import admission now reserves its slot before yielding to further database work and releases it on startup failure.
- **3 — Caption batching:** psycopg executemany pipelines cue inserts; one INSERT SELECT populates the search table per track. Source, caption and index replacement remain atomic.
- **4 — Shared SSE:** all page/component subscriptions share one EventSource per tab with cleanup of listeners and reference counting. The browser test verifies one connection even with inline and floating chats.
- **5 — Incremental transcripts:** both chat views share history and in-flight fetches. The after-cursor uses insertion order, independently of speech timestamps, so late simultaneous-speaker results are included. Text still comes from permission-checked HTTP endpoints. Reading positions remain independent and anchored when messages are prepended.
- **8 — Lazy routes:** editor/WaveSurfer and admin tools now have separate chunks and themed loading states.

Read-only media measurement on the existing 1,982,665,465-byte library gave a median tracked lookup of **0.000190 ms** over 1,000 reads, versus the earlier **773.07 ms** full scan. The full scan is still needed initially and during reconciliation; these are operation timings, not end-to-end request latency.

An isolated PostgreSQL benchmark with 1,000 cues took **159.82 ms** for the reconstructed previous per-cue insertion loop and **26.21 ms** for the new batch save (three warm samples per method), approximately **6.1× faster**. It excludes downloads/conversion and does not measure a full import.

The initial JavaScript bundle decreased from approximately **418 KB / 125 KB gzip** to **355.38 KB / 106.56 KB gzip**. Editor is **53.66 KB / 16.41 KB gzip**, admin is **11.70 KB / 4.39 KB gzip**; those load only when needed. Emoji data remains a separate chunk.

Validation: **365 backend tests passed in Docker**, including isolated PostgreSQL checks; **166 browser tests passed** across desktop and touch. Frontend build, Poetry lock validation, strict Ruff, formatting and comment/docstring scan passed. Additional coverage checks worker concurrency, responsive event-loop scheduling, storage accounting, import admission, cancellation-safe commits, batched caption indexing, late transcript ordering, shared chat requests and permission revocation. No Discord voice was joined for verification.
