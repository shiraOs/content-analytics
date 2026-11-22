import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { root } from './core.ts';
import type { Json } from './core.ts';
import { TikTokError, sanitize } from './service.ts';

export const databasePath = root + 'data/history.sqlite';
const now = () => new Date().toISOString();
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

// A separate SQLite write transaction is an OS-managed mutex, released even after SIGKILL.
export function writerLock(path = databasePath) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const lock = new DatabaseSync(path + '.lock');
  chmodSync(path + '.lock', 0o600);
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); }
  catch { lock.close(); throw new TikTokError('collection_busy', 'Another collection owns this database. Retry later.'); }
  return () => { lock.exec('ROLLBACK'); lock.close(); };
}

export class History {
  db: DatabaseSync;
  constructor(path = databasePath, readonly = false) {
    if (!readonly) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); }
    try { this.db = new DatabaseSync(path, { readOnly: readonly }); }
    catch { throw new TikTokError('history_unavailable', 'History database is unavailable. Run npm run collect first.'); }
    const schemaVersion = this.db.prepare('PRAGMA user_version').get()!.user_version;
    if (schemaVersion !== 0 && schemaVersion !== 1) { this.db.close(); throw new TikTokError('history_schema_unsupported', 'History database uses a different schema version.'); }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
    if (readonly) { this.db.exec('PRAGMA query_only=ON'); return; }
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, username TEXT, display_name TEXT);
      CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), published_at TEXT, metadata_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, status TEXT NOT NULL, details_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), target TEXT NOT NULL, retrieved_at TEXT, name TEXT NOT NULL, unit TEXT, status TEXT NOT NULL, value_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_lookup ON snapshots(target,name,retrieved_at);
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
  account(a: Json) {
    this.db.prepare('INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name').run(a.id, a.username ?? null, a.display_name ?? null);
  }
  video(accountId: string, v: Json) {
    const { public: _, ...meta } = v;
    this.db.prepare('INSERT INTO videos VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(excluded.published_at,videos.published_at),metadata_json=excluded.metadata_json')
      .run(v.id, accountId, v.published_at ?? null, JSON.stringify(sanitize(meta)));
  }
  save(run: string, accountId: string, observations: Json[]) {
    for (const o of observations) {
      const record = { account_id: accountId, target: String(o.target), retrieved_at: o.retrieved_at ?? null, name: o.name, unit: o.unit ?? 'count',
        status: o.status, value: o.status === 'available' ? o.value : null };
      const id = hash(record);
      this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?,?,?)').run(id, record.account_id, record.target, record.retrieved_at,
        record.name, record.unit, record.status, JSON.stringify(record.value ?? null));
      this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').run(run, id);
    }
  }
  videos(): Json[] {
    return this.db.prepare('SELECT * FROM videos ORDER BY published_at DESC').all().map((r: any) => ({ ...JSON.parse(r.metadata_json), account_id: r.account_id }));
  }
  runs(limit = 20): Json[] {
    return this.db.prepare("SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT ?").all(limit)
      .map((r: any) => ({ ...r, details: JSON.parse(r.details_json), details_json: undefined }));
  }
  runSnapshots(run: string): Json[] {
    return this.db.prepare('SELECT s.* FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?').all(run)
      .map((r: any) => { const { value_json, ...rest } = r; return { ...rest, value: JSON.parse(value_json) }; });
  }
}
