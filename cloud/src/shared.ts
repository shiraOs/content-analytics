// Small pieces shared by the three platform ports. Only the parts of the D1 API this Worker uses.
export type Json = Record<string, any>;
export interface D1Result<T = any> { results: T[]; meta: Json }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = any>(): Promise<T | null>;
  all<T = any>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
export interface Env {
  YOUTUBE_DB: D1Database; INSTAGRAM_DB: D1Database; TIKTOK_DB: D1Database;
  LINKEDIN_DB?: D1Database; // LinkedIn analytics downloads, imported from your computer (no collector job)
  SITE_DB?: D1Database; // the website: Cloudflare Web Analytics, Search Console, GA4, Bing (src/site)
  INSTAGRAM_USERNAME?: string; SITE_HOST?: string; SITE_CF_ACCOUNT_ID?: string; SITE_CF_SITE_TAG?: string; SITE_GA4_PROPERTY?: string; SITE_BIO_PATHS?: string; // plain vars, not secrets
  SITE_CF_TOKEN?: string; SITE_GOOGLE_CREDENTIAL?: string; SITE_BING_KEY?: string;
  YOUTUBE_CLIENT?: string; YOUTUBE_CREDENTIAL?: string; INSTAGRAM_CREDENTIAL?: string;
  TIKTOK_CLIENT?: string; TIKTOK_CREDENTIAL?: string; DIGEST_KEY?: string;
}

export const DAY = 86400000;
export const now = () => new Date().toISOString();
export const validTime = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:?\d\d)$/.test(s) && Number.isFinite(Date.parse(s));

// Same snapshot IDs as the local collector (hex SHA-256 of the JSON record), so imported and new rows deduplicate alike.
export async function hash(v: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Each step commits in one D1 batch, which D1 runs as a single transaction.
export async function commit(db: D1Database, statements: D1PreparedStatement[]) {
  if (statements.length) await db.batch(statements);
}

// A rotated or renewed sign-in lives in D1. The Worker secret holds the one copied from your computer;
// whichever was saved last wins, so a fresh `npm run secrets` after a new sign-in takes over.
const savedTime = (c: Json | null) => c ? Date.parse(c.rotated_at ?? c.saved_at ?? '') || 0 : -1;
export async function loadCredential(db: D1Database, id: string, secret?: string): Promise<Json | null> {
  const row = await db.prepare('SELECT credential_json FROM credential_state WHERE id=?').bind(id).first<{ credential_json: string }>();
  const stored = row ? JSON.parse(row.credential_json) as Json : null;
  let copied: Json | null = null;
  try { copied = secret ? JSON.parse(secret) : null; } catch { copied = null; }
  return savedTime(stored) >= savedTime(copied) ? stored : copied;
}
export async function storeCredential(db: D1Database, id: string, c: Json) {
  await db.prepare('INSERT INTO credential_state VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET credential_json=excluded.credential_json,updated_at=excluded.updated_at')
    .bind(id, JSON.stringify(c), now()).run();
}
export function parseSecret(secret: string | undefined): Json | null {
  try { return secret ? JSON.parse(secret) : null; } catch { return null; }
}
