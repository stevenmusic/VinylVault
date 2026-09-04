-- VinylVault schema (Turso / libSQL)
-- 三層結構：artists -> albums -> versions
-- 執行方式：
--   turso db shell vinylvault-db < db/schema.sql
-- 或貼到 Turso 網頁後台的 SQL Console 執行。

PRAGMA foreign_keys = ON;

--------------------------------------------------------------------------------
-- 1. 歌手 / 團體
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artists (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  sort_name   TEXT,                        -- 排序用（例：The Beatles -> Beatles, The）
  country     TEXT,
  image_url   TEXT,
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name ON artists(name);

--------------------------------------------------------------------------------
-- 2. 專輯
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS albums (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_id    INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title        TEXT    NOT NULL,
  release_year INTEGER,
  cover_url    TEXT,
  label        TEXT,
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_albums_artist ON albums(artist_id);

--------------------------------------------------------------------------------
-- 3. 版本（黑膠實體版本：顏色 / 限量 / 地區 / 售價 ...）
--------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS versions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id      INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,          -- 版本名稱，例：Gold Nugget LP
  cover_url     TEXT,                      -- 版本封面圖
  color         TEXT,                      -- 唱片顏色文字，例：Translucent Gold
  color_hex     TEXT,                      -- 顏色色票，例：#C9A24B
  is_limited    INTEGER NOT NULL DEFAULT 0 CHECK (is_limited IN (0,1)),
  is_exclusive  INTEGER NOT NULL DEFAULT 0 CHECK (is_exclusive IN (0,1)),
  exclusive_to  TEXT,                      -- 通路獨佔，例：Target / HMV / Official Store
  region        TEXT,                      -- 地區，例：US / UK / JP / TW / EU
  release_date  TEXT,                      -- YYYY-MM-DD
  edition_size  INTEGER,                   -- 限量張數
  price         REAL,                      -- 售價
  currency      TEXT    DEFAULT 'USD',
  buy_url       TEXT,                      -- 購買連結
  want          INTEGER NOT NULL DEFAULT 0 CHECK (want IN (0,1)),
  owned         INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0,1)),
  notes         TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_versions_album  ON versions(album_id);
CREATE INDEX IF NOT EXISTS idx_versions_want   ON versions(want);
CREATE INDEX IF NOT EXISTS idx_versions_owned  ON versions(owned);
CREATE INDEX IF NOT EXISTS idx_versions_region ON versions(region);

--------------------------------------------------------------------------------
-- updated_at 觸發器
--------------------------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_artists_updated
AFTER UPDATE ON artists FOR EACH ROW
BEGIN
  UPDATE artists SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_albums_updated
AFTER UPDATE ON albums FOR EACH ROW
BEGIN
  UPDATE albums SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_versions_updated
AFTER UPDATE ON versions FOR EACH ROW
BEGIN
  UPDATE versions SET updated_at = datetime('now') WHERE id = OLD.id;
END;
