// Port of instagram/src/service.ts. The account is verified once per invocation; Reels
// come from that verified owned listing, so a batch of Reels does not repeat the listing.
import { credentials, request, status, normalize, metrics, version, redact, reauth } from './core.ts';
import type { Json, Result } from './core.ts';
import type { D1Database } from '../shared.ts';

export class InstagramError extends Error {
  code: string;
  details: Json;
  constructor(code: string, message: string, details: Json = {}) {
    super(message); this.code = code; this.details = details;
  }
}
// Public output never includes raw API bodies or paging URLs. Remove URLs containing
// credential parameters even when the underlying transport has already redacted them.
export function sanitize(value: any, token = ''): any {
  const clean = redact(value, token);
  if (typeof clean === 'string') return clean.replace(/https?:\/\/[^\s"<>]+/gi,
    url => /access_token|client_secret|appsecret_proof|\[REDACTED\]/i.test(url) ? '[credential URL removed]' : url);
  if (Array.isArray(clean)) return clean.map(v => sanitize(v));
  if (clean && typeof clean === 'object') return Object.fromEntries(Object.entries(clean).map(([k,v]) => [k, sanitize(v)]));
  return clean;
}
function requireSuccess(r: Result, operation: string) {
  if (status(r) !== 'available') throw new InstagramError(status(r), `${operation} failed. ${status(r) === 'authentication_failed' ? reauth : 'Retry network/rate-limit failures on a later run, or restore account access for permission failures.'}`,
    { http_status: r.http_status, meta_code: typeof r.body.error?.code === 'number' ? r.body.error.code : null, retrieved_at: r.retrieved_at });
}
function publicMedia(m: Json): Json {
  let permalink = null;
  try { const u = new URL(m.permalink); if (u.protocol === 'https:' && ['instagram.com','www.instagram.com'].includes(u.hostname)) permalink = u.origin + u.pathname; } catch {}
  return { id: m.id, caption: m.caption ?? null, media_type: m.media_type ?? null,
    media_product_type: m.media_product_type ?? null, timestamp: m.timestamp ?? null, permalink };
}
// username: the account this Worker may read (the INSTAGRAM_USERNAME var). Every run checks the token belongs to it.
export type InstagramDeps = { credentials: () => Promise<Json>; request: typeof request; username?: string };
export const instagramDeps = (db: D1Database, secret?: string, username?: string): InstagramDeps => ({ credentials: credentials(db, secret), request, username });

export function createInstagramService(deps: InstagramDeps) {
  async function connect() {
    try { return await deps.credentials(); } catch { throw new InstagramError('not_configured', 'No usable Instagram token. ' + reauth); }
  }
  const expectedUsername = (deps.username ?? '').trim().replace(/^@/, '').toLowerCase();
  async function identity(c: Json) {
    if (!expectedUsername) throw new InstagramError('not_configured', 'Set the INSTAGRAM_USERNAME var in wrangler.jsonc.');
    const r = await deps.request(c.access_token, 'me', { fields: 'user_id,username,account_type' });
    requireSuccess(r, 'Account verification');
    const a = r.body.data?.[0] ?? r.body;
    if (a.username?.toLowerCase() !== expectedUsername) throw new InstagramError('account_mismatch', 'Credential identifies a different account; media access stopped.');
    if (!/^\d+$/.test(String(a.user_id))) throw new InstagramError('invalid_response', 'Meta omitted the account user_id. Retry later.');
    return { user_id: String(a.user_id), username: a.username, account_type: a.account_type ?? null };
  }
  async function page(c: Json, account: Json, limit: number, after?: string) {
    const r = await deps.request(c.access_token, `${account.user_id}/media`, {
      fields: 'id,caption,media_type,media_product_type,permalink,timestamp', limit, ...(after ? { after } : {}) });
    requireSuccess(r, 'Media listing');
    if (!Array.isArray(r.body.data)) throw new InstagramError('invalid_response', 'Meta media response omitted its data array. Retry later.');
    const media = r.body.data.slice(0, limit).map(publicMedia);
    const cursor = r.body.paging?.cursors?.after;
    const hasNext = Boolean(r.body.paging?.next);
    if (hasNext && (typeof cursor !== 'string' || !/^[A-Za-z0-9_~.+=/-]{1,2048}$/.test(cursor) || cursor.includes(c.access_token)))
      throw new InstagramError('invalid_response', 'Meta returned an unusable pagination cursor. Retry the first page.');
    return { account, api_version: version, retrieved_at: r.retrieved_at, media,
      pagination: { has_next_page: hasNext, after: hasNext ? cursor : null } };
  }
  return {
    // One verified session: the token and the account it belongs to.
    async session() { const c = await connect(); return { c, account: await identity(c) }; },
    async listRecentMedia(s: { c: Json; account: Json }, limit = 10, after?: string) {
      return sanitize(await page(s.c, s.account, limit, after), s.c.access_token);
    },
    // `reel` must come from this account's owned listing (the discovery step), which is the ownership check.
    async getReelInsights(s: { c: Json; account: Json }, reel: Json) {
      if (reel.media_product_type !== 'REELS') throw new InstagramError('not_a_reel', 'The specified owned media is not a Reel.');
      const results = await Promise.all(metrics.map(async name => {
        const r = await deps.request(s.c.access_token, `${reel.id}/insights`, { metric: name, period: 'lifetime' });
        return { ...normalize(name, r), unit: name.startsWith('ig_reels_') ? 'milliseconds' : 'count',
          unit_source: 'Meta metric definition; native value, no conversion', http_status: r.http_status, api_version_returned: r.api_version_returned };
      }));
      return sanitize({ account: s.account, media: reel, api_version: version, retrieved_at: new Date().toISOString(),
        metrics: [...results, { name: 'follows', status: 'unsupported', value: null, period: null, unit: null, retrieved_at: new Date().toISOString(), reason: 'Meta lists follows for FEED/STORY, not REELS; not requested.' }] }, s.c.access_token);
    }
  };
}
export type InstagramService = ReturnType<typeof createInstagramService>;
