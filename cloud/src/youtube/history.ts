// Port of youtube/src/history.ts onto D1. Same tables, same snapshot IDs.
// Writes are returned as statements so each collection step commits in one batch.
import { counters } from './core.ts';
import type { Json } from './core.ts';
import { sanitize } from './service.ts';
import { hash, now, validTime, commit } from '../shared.ts';
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
  channel(ch: Json) {
    return this.db.prepare('INSERT INTO channels VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,handle=excluded.handle').bind(ch.id, ch.title ?? null, ch.handle ?? null);
  }
  video(channelId: string, v: Json) {
    const { public: _, ...meta } = v;
    return this.db.prepare('INSERT INTO videos VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(excluded.published_at,videos.published_at),metadata_json=excluded.metadata_json')
      .bind(v.id, channelId, v.published_at ?? null, JSON.stringify(sanitize(meta)));
  }
  async save(run: string, channelId: string, observations: Json[]): Promise<D1PreparedStatement[]> {
    const out: D1PreparedStatement[] = [];
    for (const raw of observations) {
      const o = sanitize(raw);
      const record = { channel_id: channelId, target: String(o.target), retrieved_at: validTime(o.retrieved_at) ? o.retrieved_at : null,
        window: o.window, start_date: o.start_date ?? null, end_date: o.end_date ?? null, name: o.name, unit: o.unit ?? null,
        status: o.status, value: o.status === 'available' ? o.value : null, source: o.source,
        details: { dimension: o.dimension ?? null, content_type: o.content_type ?? null, type_source: o.type_source ?? null,
          timestamp_semantics: 'API request start; YouTube Analytics data usually lags 2–3 days behind end_date' } };
      const id = await hash(record);
      out.push(this.db.prepare('INSERT OR IGNORE INTO snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, record.channel_id, record.target, record.retrieved_at,
        record.window, record.start_date, record.end_date, record.name, record.unit, record.status, JSON.stringify(record.value ?? null), record.source, JSON.stringify(record.details)));
      out.push(this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').bind(run, id));
    }
    return out;
  }
  async videos(): Promise<Json[]> {
    const r = await this.db.prepare('SELECT * FROM videos ORDER BY published_at DESC').all();
    return r.results.map((row: any) => ({ ...JSON.parse(row.metadata_json), channel_id: row.channel_id }));
  }
  async runs(limit = 20): Promise<Json[]> {
    const r = await this.db.prepare("SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT ?").bind(limit).all();
    return r.results.map((row: any) => ({ ...row, details: JSON.parse(row.details_json), details_json: undefined }));
  }
  async runSnapshots(run: string): Promise<Json[]> {
    const r = await this.db.prepare('SELECT s.* FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?').bind(run).all();
    return r.results.map(decode);
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
