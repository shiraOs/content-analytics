// History for numbers that come from a file you download (LinkedIn analytics, TikTok Studio), not from an API.
// Same tables on your computer (node:sqlite, inside each platform's data/history.sqlite) and in the cloud (D1).
//
//   export_files   one row per imported file (by SHA-256 of its bytes, so the same file never counts twice)
//   export_items   posts/videos named in a file (URL, publish date, short title), updated by newer files
//   export_values  one number per row, immutable, with its own period:
//                    day      period_start = period_end = that date (activity on that day)
//                    range    period_start..period_end = the file's date range (total within that range)
//                    point    period_start NULL, period_end = the date it was true (e.g. total followers)
//                  status 'available' or 'missing'. A blank or "-" cell is stored as missing, never as 0.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Json = Record<string, any>;
export type Kind = 'day' | 'range' | 'point';
export type Value = { target: string; name: string; kind: Kind; period_start: string | null; period_end: string; unit: string; value: number | null };
export type Item = { id: string; type: string; url: string | null; published_at: string | null; title_start: string | null; metadata?: Json };
export type Parsed = {
  platform: 'linkedin' | 'tiktok';
  file_kind: string;             // e.g. linkedin_content, tiktok_studio
  range_start: string | null;    // YYYY-MM-DD, inclusive
  range_end: string | null;      // YYYY-MM-DD, inclusive
  items: Item[];
  values: Value[];
  notes: string[];               // what the file did not contain, sheets skipped, etc.
};

export const schema = `
CREATE TABLE IF NOT EXISTS export_files (digest TEXT PRIMARY KEY, platform TEXT NOT NULL, file_kind TEXT NOT NULL, imported_at TEXT NOT NULL,
  range_start TEXT, range_end TEXT, details_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS export_items (id TEXT PRIMARY KEY, platform TEXT NOT NULL, type TEXT NOT NULL, url TEXT, published_at TEXT, title_start TEXT,
  metadata_json TEXT NOT NULL, last_file TEXT REFERENCES export_files(digest));
CREATE TABLE IF NOT EXISTS export_values (id TEXT PRIMARY KEY, file_digest TEXT NOT NULL REFERENCES export_files(digest), target TEXT NOT NULL, name TEXT NOT NULL,
  kind TEXT NOT NULL, period_start TEXT, period_end TEXT NOT NULL, unit TEXT NOT NULL, status TEXT NOT NULL, value_json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS export_values_lookup ON export_values(target,name,period_end);
CREATE INDEX IF NOT EXISTS export_values_file ON export_values(file_digest);
`;

export const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

export function openStore(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;' + schema);
  return db;
}

export const alreadyImported = (db: DatabaseSync, digest: string) => Boolean(db.prepare('SELECT 1 FROM export_files WHERE digest=?').get(digest));

// Every file keeps its own readings (IDs include the file), so an overlapping later file never hides an
// earlier one and a revised number keeps both readings; readers take the reading from the newest file.
export function save(db: DatabaseSync, digest: string, parsed: Parsed, at = new Date().toISOString()): { values: number; missing: number; items: number } {
  const valid = (v: Value) => Boolean(v.target && v.name && v.period_end && /^\d{4}-\d\d-\d\d$/.test(v.period_end));
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO export_files VALUES (?,?,?,?,?,?,?)').run(digest, parsed.platform, parsed.file_kind, at, parsed.range_start, parsed.range_end,
      JSON.stringify({ notes: parsed.notes, counts: { items: parsed.items.length, values: parsed.values.length } }));
    const item = db.prepare(`INSERT INTO export_items VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      url=COALESCE(excluded.url,export_items.url), published_at=COALESCE(excluded.published_at,export_items.published_at),
      title_start=COALESCE(excluded.title_start,export_items.title_start), metadata_json=excluded.metadata_json, last_file=excluded.last_file`);
    for (const i of parsed.items) item.run(i.id, parsed.platform, i.type, i.url, i.published_at, i.title_start, JSON.stringify(i.metadata ?? {}), digest);
    const value = db.prepare('INSERT OR IGNORE INTO export_values VALUES (?,?,?,?,?,?,?,?,?,?)');
    let missing = 0, stored = 0;
    for (const v of parsed.values.filter(valid)) {
      const status = v.value === null ? 'missing' : 'available';
      if (status === 'missing') missing++;
      const id = sha256(JSON.stringify([digest, v.target, v.name, v.kind, v.period_start, v.period_end])).slice(0, 40);
      stored += Number(value.run(id, digest, v.target, v.name, v.kind, v.period_start, v.period_end, v.unit, status, JSON.stringify(v.value)).changes);
    }
    db.exec('COMMIT');
    return { values: stored, missing, items: parsed.items.length };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
