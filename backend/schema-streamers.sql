-- 配信者とスプレッドシートの紐づけ
CREATE TABLE IF NOT EXISTS streamers (
    id                  TEXT    NOT NULL PRIMARY KEY,                           -- UUIDv7
    spreadsheet_id      TEXT    NOT NULL,                                       -- GoogleスプレッドシートのID
    repertoire_sheet    TEXT    NOT NULL DEFAULT 'Repertoire',                  -- レパートリーのシート名
    history_sheet       TEXT    NOT NULL DEFAULT 'History',                     -- 歌唱履歴のシート名
    timezone            TEXT    NOT NULL DEFAULT 'Asia/Tokyo',                  -- タイムゾーン
    spreadsheet_title   TEXT,                                                  -- スプレッドシートのタイトル
    title_synced_at     INTEGER,                                                -- タイトルの同期日時
    display_name        TEXT,                                                   -- 表示名
    is_public           INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0, 1)), -- 公開かどうか
    overlay_key         TEXT,
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL
) STRICT;

-- 1つのスプレッドシートを2人の配信者に紐づけしない。
-- 登録時のすでに紐づいているかどうかの判定もこのインデックスで済む
CREATE UNIQUE INDEX IF NOT EXISTS uq_streamers_spreadsheet ON streamers (spreadsheet_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_streamers_overlay_key ON streamers (overlay_key);

-- アクセストークン
-- 平文は保存しない
CREATE TABLE IF NOT EXISTS streamer_tokens (
    token_hash      TEXT    NOT NULL PRIMARY KEY, -- SHA256ハッシュ
    streamer_id     TEXT    NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    scope           TEXT    NOT NULL DEFAULT 'full' CHECK (scope IN ('full', 'dock')), -- "full" or "dock"
    label           TEXT,
    created_at      INTEGER NOT NULL,
    last_used_at    INTEGER,
    revoked_at      INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_streamer_tokens_owner ON streamer_tokens (streamer_id, created_at);

-- performances
-- 歌唱記録の送信待ち箱
CREATE TABLE IF NOT EXISTS performances (
    id              TEXT    NOT NULL PRIMARY KEY, -- UUIDv7
    streamer_id     TEXT    NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,
    song_id         TEXT    NOT NULL,
    sung_at         INTEGER NOT NULL,
    stream_url      TEXT,
    timestamp_sec   INTEGER,
    client_id       TEXT,
    synced_at       INTEGER,
    created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_performances_unsynced ON performances (streamer_id, created_at) WHERE synced_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_performances_client ON performances (streamer_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_performances_purge ON performances (synced_at) WHERE synced_at IS NOT NULL;

-- トークン紛失時の復旧
CREATE TABLE IF NOT EXISTS recovery_challenges (
    spreadsheet_id TEXT    NOT NULL PRIMARY KEY,
    code           TEXT    NOT NULL,
    expires_at     INTEGER NOT NULL,
    created_at     INTEGER NOT NULL
) STRICT;