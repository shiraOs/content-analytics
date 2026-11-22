// Port of tiktok/src/history.ts onto D1. Same tables, same snapshot IDs.
import type { Json } from './core.ts';
import { sanitize } from './service.ts';
import { hash, now, commit } from '../shared.ts';
import type { D1Database, D1PreparedStatement } from '../shared.ts';

export class History {
  db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  commit(statements: D1PreparedStatement[]) { return commit(this.db, statements); }
  async recover() {
    await this.db.prepare("UPDATE collection_runs SET status='interrupted', finished_at=? WHERE status='running'").bind(now()).run();
  }
  async start(kind: string, details: Json = {}, at = now()) {
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT INTO collection_runs VALUES (?,?,?,NULL,?,?)').bind(id, kind, at, 'running', JSON.stringify(details)).run();
    return id;
  }
  async finish(id: string, status: string, details: Json) {
    await this.db.prepare('UPDATE collection_runs SET finished_at=?,status=?,details_json=? WHERE id=?').bind(now(), status, JSON.stringify(sanitize(details)), id).run();
  }
  account(a: Json) {
    return this.db.prepare('INSERT INTO accounts VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,display_name=excluded.display_name').bind(a.id, a.username ?? null, a.display_name ?? null);
  }
  video(accountId: string, v: Json) {
    const { public: _, ...meta } = v;
    return this.db.prepare('INSERT INTO videos VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(excluded.published_at,videos.published_at),metadata_json=excluded.metadata_json')
      .bind(v.id, accountId, v.published_at ?? null, JSON.stringify(sanitize(meta)));
  }
  async save(run: string, accountId: string, observations: Json[]): Promise<D1PreparedStatement[]> {
    const out: D1PreparedStatement[] = [];
    for (const o of observations) {
      const record = { account_id: accountId, target: String(o.target), retrieved_at: o.retrieved_at ?? null, name: o.name, unit: o.unit ?? 'count',
        status: o.status, value: o.status === 'available' ? o.value : null };
      const id = await hash(record);
      out.push(this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?,?,?)').bind(id, record.account_id, record.target, record.retrieved_at,
        record.name, record.unit, record.status, JSON.stringify(record.value ?? null)));
      out.push(this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').bind(run, id));
    }
    return out;
  }
  async videos(): Promise<Json[]> {
    const r = await this.db.prepare('SELECT * FROM videos ORDER BY published_at DESC').all();
    return r.results.map((row: any) => ({ ...JSON.parse(row.metadata_json), account_id: row.account_id }));
  }
  async runSnapshots(run: string): Promise<Json[]> {
    const r = await this.db.prepare('SELECT s.* FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?').bind(run).all();
    return r.results.map((row: any) => { const { value_json, ...rest } = row; return { ...rest, value: JSON.parse(value_json) }; });
  }
}
