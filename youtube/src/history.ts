import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { root, counters } from './core.ts';
import type { Json } from './core.ts';
import { YouTubeError, sanitize } from './service.ts';

export const databasePath = root + 'data/history.sqlite';
const now = () => new Date().toISOString();
export const validTime = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(s) && Number.isFinite(Date.parse(s));
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// A separate SQLite write transaction is an OS-managed mutex, released even after SIGKILL.
export function writerLock(path = databasePath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const lock = new DatabaseSync(path + '.lock');
  chmodSync(path + '.lock', 0o600);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch { lock.close(); throw new YouTubeError('collection_busy', 'Another collection owns this database. Retry later.'); }
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}

export class History {
  db: DatabaseSync;
  constructor(path = databasePath, readonly = false) {
    if (!readonly) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); }
    try { this.db = new DatabaseSync(path, { readOnly: readonly }); }
    catch { throw new YouTubeError('history_unavailable', 'History database is unavailable. Run npm run collect first.'); }
    this.db.function('epoch_ms', { deterministic: true }, value => typeof value === 'string' && validTime(value) ? Date.parse(value) : null);
    const schemaVersion = this.db.prepare('PRAGMA user_version').get()!.user_version;
    if (schemaVersion !== 0 && schemaVersion !== 1) { this.db.close(); throw new YouTubeError('history_schema_unsupported', 'History database uses a different schema version.'); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (readonly) { this.db.exec('PRAGMA query_only=ON'); return; }
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, title TEXT, handle TEXT);
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), published_at TEXT, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), target TEXT NOT NULL, retrieved_at TEXT, window TEXT NOT NULL, start_date TEXT, end_date TEXT, name TEXT NOT NULL, unit TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL, source TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_lookup ON snapshots(target,name,window,retrieved_at);
      CREATE TABLE IF NOT EXISTS run_snapshots (run_id TEXT REFERENCES collection_runs(id), snapshot_id TEXT REFERENCES snapshots(id), PRIMARY KEY(run_id,snapshot_id));
      PRAGMA user_version=1;`);
  }
  close() { this.db.close(); }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  recover() {
    this.db.prepare("UPDATE collection_runs SET status='interrupted', finished_at=? WHERE status='running'").run(now());
  }
  start(kind: string, details: Json = {}, at = now()) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO collection_runs VALUES (?,?,?,NULL,?,?)').run(id, kind, at, 'running', JSON.stringify(details));
    return id;
  }
  finish(id: string, status: string, details: Json) {
    this.db.prepare('UPDATE collection_runs SET finished_at=?,status=?,details_json=? WHERE id=?').run(now(), status, JSON.stringify(sanitize(details)), id);
  }
  channel(ch: Json) {
    this.db.prepare('INSERT INTO channels VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,handle=excluded.handle').run(ch.id, ch.title ?? null, ch.handle ?? null);
  }
  video(channelId: string, v: Json) {
    const { public: _, ...meta } = v;
    this.db.prepare('INSERT INTO videos VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(excluded.published_at,videos.published_at),metadata_json=excluded.metadata_json')
      .run(v.id, channelId, v.published_at ?? null, JSON.stringify(sanitize(meta)));
  }
  save(run: string, channelId: string, observations: Json[]) {
    for (const raw of observations) {
      const o = sanitize(raw);
      const record = { channel_id: channelId, target: String(o.target), retrieved_at: validTime(o.retrieved_at) ? o.retrieved_at : null,
        window: o.window, start_date: o.start_date ?? null, end_date: o.end_date ?? null, name: o.name, unit: o.unit ?? null,
        status: o.status, value: o.status === 'available' ? o.value : null, source: o.source,
        details: { dimension: o.dimension ?? null, content_type: o.content_type ?? null, type_source: o.type_source ?? null,
          timestamp_semantics: 'API request start; YouTube Analytics data usually lags 2–3 days behind end_date' } };
      const id = hash(record);
      this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, record.channel_id, record.target, record.retrieved_at,
        record.window, record.start_date, record.end_date, record.name, record.unit, record.status, JSON.stringify(record.value ?? null), record.source, JSON.stringify(record.details));
      this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').run(run, id);
    }
  }
  videos(): Json[] {
    return this.db.prepare('SELECT * FROM videos ORDER BY published_at DESC').all().map((r: any) => ({ ...JSON.parse(r.metadata_json), channel_id: r.channel_id }));
  }
  runs(limit = 20): Json[] {
    return this.db.prepare("SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT ?").all(limit)
      .map((r: any) => ({ ...r, details: JSON.parse(r.details_json), details_json: undefined }));
  }
  runSnapshots(run: string): Json[] {
    return this.db.prepare('SELECT s.* FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?').all(run).map(decode);
  }
  history(target: string, limit = 200, name?: string, window?: string): Json {
    const rows = this.db.prepare(`SELECT * FROM snapshots WHERE target=? AND (? IS NULL OR name=?) AND (? IS NULL OR window=?)
      ORDER BY COALESCE(epoch_ms(retrieved_at),-1) DESC,id DESC LIMIT ?`).all(target, name ?? null, name ?? null, window ?? null, window ?? null, limit);
    return { video: target === 'channel' ? null : this.db.prepare('SELECT id,published_at,metadata_json FROM videos WHERE id=?').get(target) ?? null,
      observations: rows.map(decode),
      warning: 'Observation times are API request starts, not activity times. Missing or failed observations are not zero.' };
  }
  compare(from: string, to: string): Json {
    const read = (id: string) => {
      const row = this.db.prepare('SELECT * FROM snapshots WHERE id=?').get(id);
      if (!row) throw new YouTubeError('snapshot_not_found', 'Snapshot ID not found. Get IDs from metric history.');
      return decode(row);
    };
    return compare(read(from), read(to));
  }
}
function decode(row: any): Json {
  const { value_json, details_json, ...fields } = row;
  return { ...fields, value: JSON.parse(value_json), details: JSON.parse(details_json) };
}
export function compare(a: Json, b: Json): Json {
  const interval = validTime(a.retrieved_at) && validTime(b.retrieved_at) ? { from: a.retrieved_at, to: b.retrieved_at, seconds: (Date.parse(b.retrieved_at) - Date.parse(a.retrieved_at)) / 1000 } : null;
  const result: Json = { from: a, to: b, interval, delta: null, interpretation: 'No difference calculated.' };
  if (!interval || interval.seconds <= 0) return { ...result, reason: 'Observations require known, increasing retrieval times.' };
  if (['channel_id', 'target', 'name', 'unit', 'window', 'source'].some(k => !a[k] || a[k] !== b[k]))
    return { ...result, reason: 'Channel, video, metric, unit, window or source differ.' };
  if (!['lifetime', 'public'].includes(a.window)) return { ...result, reason: 'Rolling windows cover different days; compare their values side by side, not as a difference.' };
  if (a.window === 'lifetime' && a.start_date !== b.start_date) return { ...result, reason: 'Lifetime windows start on different dates.' };
  if (a.status !== 'available' || b.status !== 'available' || !Number.isFinite(a.value) || !Number.isFinite(b.value))
    return { ...result, reason: 'Both observations must contain available numeric values.' };
  if (!counters.includes(a.name)) return { ...result, reason: 'Averages and percentages are not additive; compare endpoint values only.' };
  return { ...result, delta: b.value - a.value, interpretation: 'Observed change in a cumulative counter. Analytics lag and late corrections mean this is not exactly the activity between the two times.' };
}
