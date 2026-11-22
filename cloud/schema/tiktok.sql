-- Same tables as tiktok/src/history.ts (user_version 1), plus the cloud job and token tables.
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT, display_name TEXT);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), published_at TEXT, metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target TEXT NOT NULL, retrieved_at TEXT, name TEXT NOT NULL, unit TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_lookup ON snapshots(target,name,retrieved_at);
CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT REFERENCES collection_runs(id), snapshot_id TEXT REFERENCES snapshots(id), PRIMARY KEY(run_id,snapshot_id));
CREATE TABLE IF NOT EXISTS cloud_jobs (week TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, lease_until TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
-- TikTok may rotate the refresh token on any refresh; the newest one lives here.
CREATE TABLE IF NOT EXISTS credential_state (id TEXT PRIMARY KEY, credential_json TEXT NOT NULL, updated_at TEXT NOT NULL);

-- TikTok Studio downloads (profile views, viewers, followers per day, all-video totals), imported on your computer.
-- Same tables as ../shared/export-store.ts.
CREATE TABLE IF NOT EXISTS export_files (digest TEXT PRIMARY KEY, platform TEXT NOT NULL, file_kind TEXT NOT NULL, imported_at TEXT NOT NULL,
  range_start TEXT, range_end TEXT, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_items (id TEXT PRIMARY KEY, platform TEXT NOT NULL, type TEXT NOT NULL, url TEXT, published_at TEXT, title_start TEXT,
  metadata_json TEXT NOT NULL, last_file TEXT REFERENCES export_files(digest));
CREATE TABLE IF NOT EXISTS export_values (id TEXT PRIMARY KEY, file_digest TEXT NOT NULL REFERENCES export_files(digest), target TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, period_start TEXT, period_end TEXT NOT NULL, unit TEXT NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS export_values_lookup ON export_values(target,name,period_end);
CREATE INDEX IF NOT EXISTS export_values_file ON export_values(file_digest);
