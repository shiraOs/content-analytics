-- Same tables as instagram/src/history.ts (user_version 1), plus the cloud job and token tables.
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), publication_time TEXT, metadata_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS run_items (run_id TEXT REFERENCES collection_runs(id), media_id TEXT REFERENCES media(id), status TEXT NOT NULL, details_json TEXT NOT NULL, PRIMARY KEY(run_id,media_id));
CREATE TABLE IF NOT EXISTS metric_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), media_id TEXT NOT NULL REFERENCES media(id), retrieved_at TEXT, api_version TEXT, name TEXT NOT NULL, unit TEXT, period TEXT, meaning TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL, details_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_lookup ON metric_snapshots(media_id,retrieved_at,name);
CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT REFERENCES collection_runs(id), snapshot_id TEXT REFERENCES metric_snapshots(id), PRIMARY KEY(run_id,snapshot_id));
CREATE TABLE IF NOT EXISTS imports (digest TEXT PRIMARY KEY, run_id TEXT REFERENCES collection_runs(id));
CREATE TABLE IF NOT EXISTS cloud_jobs (week TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, lease_until TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
-- The renewed Instagram token. Newer than the INSTAGRAM_CREDENTIAL secret once Meta has renewed it.
CREATE TABLE IF NOT EXISTS credential_state (id TEXT PRIMARY KEY, credential_json TEXT NOT NULL, updated_at TEXT NOT NULL);
