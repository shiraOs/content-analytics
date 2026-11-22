import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { root, metrics } from './core.ts';
import type { Json } from './core.ts';
import { InstagramError, sanitize } from './service.ts';

export const databasePath = root + 'data/history.sqlite';
const now = () => new Date().toISOString();
export const validTime = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(s) && Number.isFinite(Date.parse(s));
export const meaning = (name: string) => metrics.includes(name) ? `instagram.reels.${name}.v1` : null;
export const unit = (name: string) => metrics.includes(name) ? (name.startsWith('ig_reels_') ? 'milliseconds' : 'count') : null;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// A separate SQLite write transaction is an OS-managed mutex. It is released even
// after SIGKILL, while the history DB can commit each item and serve WAL readers.
export function writerLock(path = databasePath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const lock = new DatabaseSync(path + '.lock');
  chmodSync(path + '.lock', 0o600);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch { lock.close(); throw new InstagramError('collection_busy', 'Another collection or import owns this database. Retry later.'); }
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}

export class History {
  db: DatabaseSync;
  constructor(path = databasePath, readonly = false) {
    if (!readonly) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); }
    try { this.db = new DatabaseSync(path, { readOnly: readonly }); }
    catch { throw new InstagramError('history_unavailable', 'History database is unavailable. Run npm run collect or npm run import:history first.'); }
    this.db.function('epoch_ms', {deterministic:true}, value => typeof value === 'string' && validTime(value) ? Date.parse(value) : null);
    const schemaVersion = this.db.prepare('PRAGMA user_version').get()!.user_version;
    if (schemaVersion !== 0 && schemaVersion !== 1) { this.db.close(); throw new InstagramError('history_schema_unsupported','History database uses a different schema version. Use a compatible integration version.'); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (readonly) { this.db.exec('PRAGMA query_only=ON'); return; }
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), publication_time TEXT, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_items (run_id TEXT REFERENCES collection_runs(id), media_id TEXT REFERENCES media(id), status TEXT NOT NULL, details_json TEXT NOT NULL, PRIMARY KEY(run_id,media_id));
      CREATE TABLE IF NOT EXISTS metric_snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), media_id TEXT NOT NULL REFERENCES media(id), retrieved_at TEXT, api_version TEXT, name TEXT NOT NULL, unit TEXT, period TEXT, meaning TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_lookup ON metric_snapshots(media_id,retrieved_at,name);
      CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT REFERENCES collection_runs(id), snapshot_id TEXT REFERENCES metric_snapshots(id), PRIMARY KEY(run_id,snapshot_id));
      CREATE TABLE IF NOT EXISTS imports (digest TEXT PRIMARY KEY, run_id TEXT REFERENCES collection_runs(id));
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover() {
    this.transaction(() => {
      this.db.prepare("UPDATE run_items SET status='interrupted' WHERE run_id IN (SELECT id FROM collection_runs WHERE status='running') AND status='pending'").run();
      this.db.prepare("UPDATE collection_runs SET status='interrupted', finished_at=? WHERE status='running'").run(now());
    });
  }
  start(kind: string, details: Json = {}) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO collection_runs VALUES (?,?,?,NULL,?,?)').run(id, kind, now(), 'running', JSON.stringify(details));
    return id;
  }
  finish(id: string, status: string, details: Json) {
    this.db.prepare('UPDATE collection_runs SET finished_at=?,status=?,details_json=? WHERE id=?').run(now(), status, JSON.stringify(sanitize(details)), id);
  }
  media(account: Json, media: Json) {
    this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username').run(String(account.user_id), account.username);
    this.db.prepare('INSERT INTO media VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET publication_time=COALESCE(excluded.publication_time,media.publication_time),metadata_json=excluded.metadata_json').run(media.id, String(account.user_id), media.timestamp ?? null, JSON.stringify(sanitize(media)));
  }
  item(run: string, mediaId: string, status: string, details: Json = {}) {
    this.db.prepare('INSERT INTO run_items VALUES (?,?,?,?) ON CONFLICT(run_id,media_id) DO UPDATE SET status=excluded.status,details_json=excluded.details_json').run(run, mediaId, status, JSON.stringify(sanitize(details)));
  }
  save(run: string, observation: Json) {
    this.media(observation.account, observation.media);
    for (const raw of observation.metrics) {
      // Only allowlisted, sanitized observation fields are persisted; credentials,
      // connection status and raw request URLs are never database inputs.
      const m = sanitize(raw);
      const record = { account_id: String(observation.account.user_id), media_id: observation.media.id,
        retrieved_at: validTime(m.retrieved_at) ? m.retrieved_at : null,
        api_version: observation.api_version ?? null, name: m.name, unit: m.unit ?? null,
        period: m.period ?? null, meaning: meaning(m.name), status: m.status,
        value: m.status === 'available' ? m.value : null,
        details: { title:m.title ?? null, description:m.description ?? null, values:m.values ?? null,
          total_value:m.total_value ?? null, http_status:m.http_status ?? null,
          api_version_returned:m.api_version_returned ?? null, error:m.error ?? null,
          reason:m.reason ?? null, unit_source:m.unit_source ?? null,
          timestamp_semantics:'API request start for fetched metrics; explicit not-requested time otherwise; null means no recorded time' } };
      const id = hash(record);
      this.db.prepare('INSERT OR IGNORE INTO metric_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, record.account_id, record.media_id, record.retrieved_at, record.api_version, record.name, record.unit, record.period, record.meaning, record.status, JSON.stringify(record.value ?? null), JSON.stringify(record.details));
      this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').run(run,id);
    }
  }
  history(mediaId: string, limit = 200, before?: string, name?: string, cursor?: string): Json {
    const anchor = cursor ? this.db.prepare('SELECT id,COALESCE(epoch_ms(retrieved_at),-1) AS time FROM metric_snapshots WHERE id=? AND media_id=?').get(cursor,mediaId) : null;
    if (cursor && !anchor) throw new InstagramError('snapshot_not_found','History cursor does not belong to this reel.');
    const rows = this.db.prepare(`SELECT * FROM metric_snapshots WHERE media_id=? AND (? IS NULL OR name=?)
      AND (? IS NULL OR epoch_ms(retrieved_at)<epoch_ms(?))
      AND (? IS NULL OR COALESCE(epoch_ms(retrieved_at),-1)<? OR (COALESCE(epoch_ms(retrieved_at),-1)=? AND id<?))
      ORDER BY COALESCE(epoch_ms(retrieved_at),-1) DESC,id DESC LIMIT ?`).all(mediaId, name ?? null, name ?? null, before ?? null, before ?? null, cursor ?? null, anchor?.time ?? -1, anchor?.time ?? -1, cursor ?? null, limit + 1);
    return { media: this.db.prepare('SELECT id,account_id,publication_time FROM media WHERE id=?').get(mediaId) ?? null,
      observations: rows.slice(0,limit).map(decode), has_more: rows.length > limit,
      next_cursor:rows.length>limit ? rows[limit-1].id : null,
      ordering:'Retrieval instant descending, snapshot ID descending; unknown times last. Pass next_cursor with the same filters.',
      warning:'Observation times are recorded API request starts, not activity times. Missing, error, unsupported and unknown-time observations are not zero.' };
  }
  compare(mediaId: string, from: string, to: string): Json {
    const read = (id: string) => {
      const row = this.db.prepare('SELECT * FROM metric_snapshots WHERE id=? AND media_id=?').get(id,mediaId);
      if (!row) throw new InstagramError('snapshot_not_found','Snapshot ID does not belong to this reel. Get IDs from metric history.');
      return decode(row);
    };
    return compare(read(from),read(to));
  }
}
function decode(row: any): Json {
  const { value_json, details_json, ...fields } = row;
  return { ...fields, value:JSON.parse(value_json), details:JSON.parse(details_json) };
}
export function compare(a: Json, b: Json): Json {
  const interval = validTime(a.retrieved_at) && validTime(b.retrieved_at) ? { from:a.retrieved_at, to:b.retrieved_at, seconds:(Date.parse(b.retrieved_at)-Date.parse(a.retrieved_at))/1000 } : null;
  const result: Json = { from:a, to:b, interval, delta:null, interpretation:'No difference calculated.' };
  if (!interval || interval.seconds <= 0) return { ...result, reason:'Observations require known, increasing retrieval times.' };
  if (['account_id','media_id','name','unit','period','meaning','api_version'].some(k => !a[k] || a[k] !== b[k]) ||
      (a.details?.api_version_returned ?? null) !== (b.details?.api_version_returned ?? null))
    return { ...result, reason:'Metric, meaning, unit, period, account, reel or API versions are incompatible or unknown.' };
  if ((a.details?.description ?? null) !== (b.details?.description ?? null)) return { ...result, reason:'Returned metric descriptions changed; meaning compatibility requires review.' };
  if ([a,b].some(s=>Array.isArray(s.details?.values) && s.details.values.length>1)) return { ...result, reason:'Multi-value series require explicit alignment; not subtracted.' };
  if (a.status !== 'available' || b.status !== 'available' || !Number.isFinite(a.value) || !Number.isFinite(b.value))
    return { ...result, reason:'Both observations must contain available finite numeric values.' };
  if (a.name === 'reach' || a.name === 'ig_reels_avg_watch_time')
    return { ...result, reason:'Reach is unique audience and watch-time average is non-additive; compare endpoint values only.' };
  if (a.period !== 'lifetime' || !['views','likes','comments','saved','shares','ig_reels_video_view_total_time'].includes(a.name))
    return { ...result, reason:'Only explicitly defined lifetime counters support differences.' };
  return { ...result, delta:b.value-a.value, interpretation:'Observed change in a lifetime counter, not necessarily activity during this interval. Negative changes are retained as downward revisions.' };
}
