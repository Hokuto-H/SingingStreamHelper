-- =====================================================================
-- performances に「確認待ち」を持たせる
--
-- ★ SQLite は列の NOT NULL を外せない (ALTER TABLE に無い)。
--   さらにこのテーブルは STRICT なので、**作り直して移す**しかない。
--
-- ★ 本番で流す前に必ずバックアップを取ること:
--     npx turso db shell <db> ".dump" > backup.sql
--
-- ★ 流す順番は上から 1 回だけ。途中で失敗したら backup から戻す。
-- =====================================================================

-- 1. 新しい形で作る
CREATE TABLE performances_new (
    id              TEXT    NOT NULL PRIMARY KEY,                       -- UUIDv7
    streamer_id     TEXT    NOT NULL REFERENCES streamers(id) ON DELETE CASCADE,

    -- ★ NULL 許容にした。NULL = まだどの曲か決まっていない (確認待ち)
    song_id         TEXT,

    -- ★ song_id が無いときの手がかり。配信者がドックで打った文字列そのもの
    title_text      TEXT,
    artist_text     TEXT,

    sung_at         INTEGER NOT NULL,                                   -- 歌った時刻 (ドックが渡す)
    stream_url      TEXT,
    timestamp_sec   INTEGER,
    client_id       TEXT,
    synced_at       INTEGER,                                            -- Sheets に書けた時刻
    created_at      INTEGER NOT NULL,

    -- ★ どちらも空の行は作らせない。
    --   曲が特定できず手がかりも無い記録は、後から誰にも直せない。
    CHECK (song_id IS NOT NULL OR title_text IS NOT NULL)
) STRICT;

-- 2. 移す (既存は全部 song_id 付き)
INSERT INTO performances_new
    (id, streamer_id, song_id, title_text, artist_text,
     sung_at, stream_url, timestamp_sec, client_id, synced_at, created_at)
SELECT
     id, streamer_id, song_id, NULL, NULL,
     sung_at, stream_url, timestamp_sec, client_id, synced_at, created_at
FROM performances;

-- 3. 入れ替える
DROP TABLE performances;
ALTER TABLE performances_new RENAME TO performances;

-- 4. インデックスを貼り直す
--    ★ 元の idx_performances_unsynced は「Sheets 未反映」を引くためのもの。
--      確認待ち (song_id IS NULL) は Sheets に送ってはいけないので除外する。
--      これを分けないと、POST /me/resync が ID 空の行を Sheets に流す。
CREATE INDEX IF NOT EXISTS idx_performances_unsynced
    ON performances (streamer_id, created_at)
    WHERE synced_at IS NULL AND song_id IS NOT NULL;

-- 確認待ちの一覧用
CREATE INDEX IF NOT EXISTS idx_performances_pending
    ON performances (streamer_id, sung_at)
    WHERE song_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_performances_client
    ON performances (streamer_id, client_id)
    WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_performances_purge
    ON performances (synced_at)
    WHERE synced_at IS NOT NULL;
