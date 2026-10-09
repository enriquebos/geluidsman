PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
                avatar TEXT, created_at REAL NOT NULL, last_login REAL NOT NULL,
                preferences TEXT NOT NULL DEFAULT '{}'
            , permission_overrides TEXT NOT NULL DEFAULT '{}');

CREATE TABLE IF NOT EXISTS sources (
                    id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL,
                    duration REAL NOT NULL, created_at REAL NOT NULL
                , media_id TEXT, importer_id TEXT REFERENCES users(id));

CREATE TABLE IF NOT EXISTS clips (
                    id TEXT PRIMARY KEY, source_id TEXT REFERENCES sources(id),
                    name TEXT NOT NULL, emoji TEXT NOT NULL, tags TEXT NOT NULL,
                    start REAL NOT NULL, "end" REAL NOT NULL, volume REAL NOT NULL,
                    created_at REAL NOT NULL
                , creator_id TEXT REFERENCES users(id));

CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY, url TEXT NOT NULL, status TEXT NOT NULL,
                    progress REAL NOT NULL DEFAULT 0, error TEXT,
                    source_id TEXT, created_at REAL NOT NULL
                , actor_id TEXT REFERENCES users(id), title TEXT);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS channel_batches (
                    id TEXT PRIMARY KEY,url TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,
                    error TEXT,created_at REAL NOT NULL
                , actor_id TEXT REFERENCES users(id), dismissed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE IF NOT EXISTS channel_items (
                    id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES channel_batches(id) ON DELETE CASCADE,
                    url TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,job_id TEXT,
                    UNIQUE(batch_id,url)
                );

CREATE TABLE IF NOT EXISTS caption_tracks (
                    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                    language TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, error TEXT
                );

CREATE TABLE IF NOT EXISTS caption_cues (
                    id INTEGER PRIMARY KEY, track_id TEXT NOT NULL REFERENCES caption_tracks(id) ON DELETE CASCADE,
                    start REAL NOT NULL, "end" REAL NOT NULL, text TEXT NOT NULL, words TEXT NOT NULL
                );

CREATE TABLE IF NOT EXISTS user_favourites (
                user_id TEXT NOT NULL REFERENCES users(id),
                clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
                PRIMARY KEY(user_id,clip_id)
            );

CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                csrf TEXT NOT NULL, credentials TEXT NOT NULL, expires_at REAL NOT NULL,
                last_seen REAL NOT NULL, checked_at REAL NOT NULL DEFAULT 0, guilds TEXT NOT NULL DEFAULT '[]'
            );

CREATE TABLE IF NOT EXISTS oauth_states (
                id TEXT PRIMARY KEY, browser TEXT NOT NULL, destination TEXT NOT NULL, expires_at REAL NOT NULL
            );

CREATE TABLE IF NOT EXISTS audit (
                id INTEGER PRIMARY KEY, timestamp REAL NOT NULL, actor_id TEXT, actor_name TEXT NOT NULL,
                action TEXT NOT NULL, resource_id TEXT, resource_name TEXT NOT NULL,
                outcome TEXT NOT NULL, guild_id TEXT, details TEXT NOT NULL
            );

CREATE VIRTUAL TABLE IF NOT EXISTS caption_search USING fts5(text, tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS caption_delete AFTER DELETE ON caption_cues BEGIN
    DELETE FROM caption_search WHERE rowid=old.id;
END;
CREATE INDEX IF NOT EXISTS audit_time ON audit(timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor_id, id DESC);

CREATE INDEX IF NOT EXISTS caption_tracks_source ON caption_tracks(source_id);

CREATE INDEX IF NOT EXISTS caption_cues_track ON caption_cues(track_id);

CREATE INDEX IF NOT EXISTS channel_items_job ON channel_items(job_id);

CREATE INDEX IF NOT EXISTS audit_resource ON audit(resource_id,outcome,id DESC);

CREATE INDEX IF NOT EXISTS sources_created ON sources(created_at DESC);

CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, channel_name TEXT NOT NULL,
    started_at DOUBLE PRECISION NOT NULL, ended_at DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS conversation_messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    speaker_id TEXT NOT NULL, speaker_name TEXT NOT NULL, avatar TEXT,
    started_at DOUBLE PRECISION NOT NULL, ended_at DOUBLE PRECISION NOT NULL,
    text TEXT NOT NULL, language TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_triggers (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), clip_id TEXT NOT NULL,
    phrase TEXT NOT NULL, mode TEXT NOT NULL, target TEXT NOT NULL,
    speakers TEXT NOT NULL, cooldown DOUBLE PRECISION NOT NULL, enabled INTEGER NOT NULL,
    action TEXT NOT NULL DEFAULT 'play', delay DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_time ON conversations(started_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversation_messages_time ON conversation_messages(session_id,started_at,id);
CREATE INDEX IF NOT EXISTS conversation_triggers_owner ON conversation_triggers(owner_id);

CREATE TABLE IF NOT EXISTS action_triggers (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), event TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'play', clip_id TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT 'everyone',
    speakers TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
    delay DOUBLE PRECISION NOT NULL DEFAULT 0, cooldown DOUBLE PRECISION NOT NULL DEFAULT 5,
    created_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS action_triggers_event ON action_triggers(event,enabled,created_at,id);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_sound_unique ON conversation_triggers(clip_id) WHERE action='play';

CREATE TABLE IF NOT EXISTS activity_totals (
    actor_id TEXT PRIMARY KEY, name TEXT NOT NULL, created BIGINT NOT NULL DEFAULT 0, played BIGINT NOT NULL DEFAULT 0
);
INSERT INTO activity_totals(actor_id,name,created,played)
SELECT actor_id,MAX(actor_name),SUM(CASE WHEN action='sound.create' THEN 1 ELSE 0 END),
SUM(CASE WHEN action='sound.play' THEN 1 ELSE 0 END)
FROM audit WHERE actor_id IS NOT NULL AND outcome='success' AND action IN ('sound.create','sound.play')
AND NOT EXISTS (SELECT 1 FROM settings WHERE key='activity_totals_initialized')
AND (guild_id IS NULL OR guild_id='1352422295402057759') GROUP BY actor_id
ON CONFLICT(actor_id) DO NOTHING;
INSERT INTO settings(key,value) VALUES ('activity_totals_initialized','true') ON CONFLICT(key) DO NOTHING;
