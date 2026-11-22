// A small stand-in for Cloudflare D1 on node:sqlite, enough for the collectors and the digest.
// batch() runs in one transaction like D1. The schema files are the same ones applied to the real databases.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { D1Database, D1PreparedStatement, Env } from '../src/shared.ts';

class Statement implements D1PreparedStatement {
  db: DatabaseSync; sql: string; values: unknown[];
  constructor(db: DatabaseSync, sql: string, values: unknown[] = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values: unknown[]) {
    if (values.some(v => v === undefined)) throw new Error('D1_TYPE_ERROR: undefined is not a supported bind value');
    return new Statement(this.db, this.sql, values);
  }
  exec() { return this.db.prepare(this.sql).run(...this.values as any[]); }
  async first<T = any>() { return (this.db.prepare(this.sql).get(...this.values as any[]) ?? null) as T | null; }
  async all<T = any>() { return { results: this.db.prepare(this.sql).all(...this.values as any[]) as T[], meta: {} }; }
  async run() { const r = this.exec(); return { results: [], meta: { changes: Number(r.changes) } }; }
}

export class FakeD1 implements D1Database {
  db: DatabaseSync;
  queries = 0;
  path: string;
  constructor(path = mkdtempSync(tmpdir() + '/d1-') + '/db.sqlite', schema?: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON');
    if (schema) this.db.exec(readFileSync(new URL(`../schema/${schema}.sql`, import.meta.url), 'utf8'));
  }
  prepare(sql: string) { this.queries++; return new Statement(this.db, sql); }
  async batch(statements: D1PreparedStatement[]) {
    this.db.exec('BEGIN');
    try { const out = statements.map(s => { (s as Statement).exec(); return { results: [], meta: {} }; }); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
}

export function fakeEnv(extra: Partial<Env> = {}): Env & { YOUTUBE_DB: FakeD1; INSTAGRAM_DB: FakeD1; TIKTOK_DB: FakeD1; LINKEDIN_DB: FakeD1 } {
  return { YOUTUBE_DB: new FakeD1(undefined, 'youtube'), INSTAGRAM_DB: new FakeD1(undefined, 'instagram'), TIKTOK_DB: new FakeD1(undefined, 'tiktok'),
    LINKEDIN_DB: new FakeD1(undefined, 'linkedin'), ...extra } as any;
}
