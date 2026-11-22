-- Same tables as youtube/src/history.ts (user_version 1), plus the cloud job table.
CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, title TEXT, handle TEXT);
CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), published_at TEXT, metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), target TEXT NOT NULL, retrieved_at TEXT, window TEXT NOT NULL, start_date TEXT, end_date TEXT, name TEXT NOT NULL, unit TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_lookup ON snapshots(target,name,window,retrieved_at);
CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT REFERENCES collection_runs(id), snapshot_id TEXT REFERENCES snapshots(id), PRIMARY KEY(run_id,snapshot_id));
CREATE TABLE IF NOT EXISTS cloud_jobs (week TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, lease_until TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
