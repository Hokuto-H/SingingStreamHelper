-- マスターDB SQL
-- 設計方針
-- 表示用の列(title/ reading_title/ artist)と、検索・整列用の正規化キー(title_keyなど)を分離する
-- 並び順は(reading_key, id)すなわち、あいうえお順

CREATE TABLE IF NOT EXISTS songs (
    id              TEXT    NOT NULL PRIMARY KEY,   -- UUIDv7
    title           TEXT    NOT NULL,               -- 表示用の曲名
    reading_title   TEXT    NOT NULL,               -- 表示用の読み
    artist          TEXT    NOT NULL,               -- 表示用のアーティスト名
    title_key       TEXT    NOT NULL,               -- 検索・整列用の正規化キー
    reading_key     TEXT    NOT NULL,               -- 検索・整列用の正規化キー
    artist_key      TEXT    NOT NULL,               -- 検索・整列用の正規化キー
    created_at      INTEGER NOT NULL                -- 作成日時(epoch milliseconds)
) STRICT;

-- 並び順
-- LIMITに達した時点で打ち切れる
CREATE INDEX IF NOT EXISTS idx_songs_reading
    ON songs (reading_key, id, title, reading_title, artist, created_at, artist_key);

-- 曲名検索の表記側
CREATE INDEX IF NOT EXISTS idx_songs_title
    ON songs (title_key, id, title, reading_title, artist, created_at, artist_key);

-- アーティスト名の前方一致
CREATE INDEX IF NOT EXISTS idx_songs_artist
    ON songs (artist_key, reading_key, id, title, reading_title, artist, created_at);

-- 重複防止
CREATE UNIQUE INDEX IF NOT EXISTS uq_songs_title_artist
    ON songs (title_key, artist_key);