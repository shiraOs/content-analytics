-- LinkedIn has no API for a personal profile, so all numbers come from the analytics file you download and import
-- on your computer (linkedin/, then `npm run import:exports` here). Same tables as ../shared/export-store.ts.
CREATE TABLE IF NOT EXISTS export_files (digest TEXT PRIMARY KEY, platform TEXT NOT NULL, file_kind TEXT NOT NULL, imported_at TEXT NOT NULL,
  range_start TEXT, range_end TEXT, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_items (id TEXT PRIMARY KEY, platform TEXT NOT NULL, type TEXT NOT NULL, url TEXT, published_at TEXT, title_start TEXT,
  metadata_json TEXT NOT NULL, last_file TEXT REFERENCES export_files(digest));
CREATE TABLE IF NOT EXISTS export_values (id TEXT PRIMARY KEY, file_digest TEXT NOT NULL REFERENCES export_files(digest), target TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, period_start TEXT, period_end TEXT NOT NULL, unit TEXT NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS export_values_lookup ON export_values(target,name,period_end);
CREATE INDEX IF NOT EXISTS export_values_file ON export_values(file_digest);
