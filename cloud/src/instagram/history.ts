// Port of instagram/src/history.ts onto D1. Same tables, same snapshot IDs.
import { metrics } from './core.ts';
import type { Json } from './core.ts';
import { sanitize } from './service.ts';
import { hash, now, validTime, commit } from '../shared.ts';
import type { D1Database, D1PreparedStatement } from '../shared.ts';

export const meaning = (name: string) => metrics.includes(name) ? `instagram.reels.${name}.v1` : null;
export const unit = (name: string) => metrics.includes(name) ? (name.startsWith('ig_reels_') ? 'milliseconds' : 'count') : null;

export class History {
  db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  commit(statements: D1PreparedStatement[]) { return commit(this.db, statements); }
  // Only before a new collection starts: an unfinished run from an earlier invocation becomes interrupted.
  async recover() {
    await this.commit([
      this.db.prepare("UPDATE run_items SET status='interrupted' WHERE run_id IN (SELECT id FROM collection_runs WHERE status='running') AND status='pending'"),
      this.db.prepare("UPDATE collection_runs SET status='interrupted', finished_at=? WHERE status='running'").bind(now())]);
  }
  async start(kind: string, details: Json = {}) {
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT INTO collection_runs VALUES (?,?,?,NULL,?,?)').bind(id, kind, now(), 'running', JSON.stringify(details)).run();
    return id;
  }
  async finish(id: string, status: string, details: Json) {
    await this.db.prepare('UPDATE collection_runs SET finished_at=?,status=?,details_json=? WHERE id=?').bind(now(), status, JSON.stringify(sanitize(details)), id).run();
  }
  media(account: Json, media: Json): D1PreparedStatement[] {
    return [this.db.prepare('INSERT INTO accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username').bind(String(account.user_id), account.username),
      this.db.prepare('INSERT INTO media VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET publication_time=COALESCE(excluded.publication_time,media.publication_time),metadata_json=excluded.metadata_json').bind(media.id, String(account.user_id), media.timestamp ?? null, JSON.stringify(sanitize(media)))];
  }
  item(run: string, mediaId: string, status: string, details: Json = {}) {
    return this.db.prepare('INSERT INTO run_items VALUES (?,?,?,?) ON CONFLICT(run_id,media_id) DO UPDATE SET status=excluded.status,details_json=excluded.details_json').bind(run, mediaId, status, JSON.stringify(sanitize(details)));
  }
  async save(run: string, observation: Json): Promise<D1PreparedStatement[]> {
    const out = this.media(observation.account, observation.media);
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
      const id = await hash(record);
      out.push(this.db.prepare('INSERT OR IGNORE INTO metric_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, record.account_id, record.media_id, record.retrieved_at, record.api_version, record.name, record.unit, record.period, record.meaning, record.status, JSON.stringify(record.value ?? null), JSON.stringify(record.details)));
      out.push(this.db.prepare('INSERT OR IGNORE INTO run_snapshots VALUES (?,?)').bind(run, id));
    }
    return out;
  }
}
