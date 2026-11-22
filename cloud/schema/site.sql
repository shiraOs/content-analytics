-- Website weekly numbers: Cloudflare Web Analytics, Search Console, Google Analytics 4, Bing.
-- One collection run per Sunday; every value is stored with its source, window and dates, never overwritten.
CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
-- window: 'this' / 'prev' (with date_from/date_to) or 'now' (a status read at retrieved_at, e.g. sitemap or index state).
-- dimension: 'total', 'date', 'path', 'bio', 'referer', 'country', 'device', 'query', 'page', 'source', 'sitemap', 'index'.
CREATE TABLE IF NOT EXISTS site_values (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES collection_runs(id), source TEXT NOT NULL,
  window TEXT NOT NULL, date_from TEXT, date_to TEXT, dimension TEXT NOT NULL, key TEXT NOT NULL, metric TEXT NOT NULL,
  value_json TEXT NOT NULL, retrieved_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS site_values_run ON site_values(run_id, source, window, dimension);
CREATE INDEX IF NOT EXISTS site_values_history ON site_values(source, dimension, key, metric, date_to);
CREATE TABLE IF NOT EXISTS cloud_jobs (week TEXT PRIMARY KEY, status TEXT NOT NULL, attempts INTEGER NOT NULL, lease_until TEXT, state_json TEXT NOT NULL, updated_at TEXT NOT NULL);
