import { credentials, request, status, normalize, metrics, version, redact } from './core.ts';
import type { Json, Result } from './core.ts';

// The Instagram account this tool may read, from the INSTAGRAM_USERNAME environment variable.
// Every run checks that the token belongs to it and stops if not.
export const expectedUsername = (process.env.INSTAGRAM_USERNAME ?? '').trim().replace(/^@/, '').toLowerCase();
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
  if (status(r) !== 'available') throw new InstagramError(status(r), `${operation} failed. Check connection status; retry network/rate-limit failures, or restore account access for authentication/permission failures.`,
    { http_status: r.http_status, meta_code: typeof r.body.error?.code === 'number' ? r.body.error.code : null, retrieved_at: r.retrieved_at });
}
function publicMedia(m: Json): Json {
  let permalink = null;
  try { const u = new URL(m.permalink); if (u.protocol === 'https:' && ['instagram.com','www.instagram.com'].includes(u.hostname)) permalink = u.origin + u.pathname; } catch {}
  return { id: m.id, caption: m.caption ?? null, media_type: m.media_type ?? null,
    media_product_type: m.media_product_type ?? null, timestamp: m.timestamp ?? null, permalink };
}
export function createInstagramService(deps = { credentials, request }) {
  const owned = new Map<string, Json>();
  async function connect() {
    if (!expectedUsername) throw new InstagramError('not_configured', 'Set INSTAGRAM_USERNAME to the Instagram account you sign in with.');
    let c: Json;
    try { c = await deps.credentials(); } catch { throw new InstagramError('not_configured', 'No usable local Instagram credential. Restore the existing private credential file or run npm run auth in your own terminal.'); }
    return c;
  }
  async function identity(c: Json) {
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
    for (const m of media) { owned.set(`${account.user_id}:${m.id}`, m); if (owned.size > 500) owned.delete(owned.keys().next().value!); }
    const cursor = r.body.paging?.cursors?.after;
    const hasNext = Boolean(r.body.paging?.next);
    if (hasNext && (typeof cursor !== 'string' || !/^[A-Za-z0-9_~.+=/-]{1,2048}$/.test(cursor) || cursor.includes(c.access_token)))
      throw new InstagramError('invalid_response', 'Meta returned an unusable pagination cursor. Retry the first page.');
    return { account, api_version: version, retrieved_at: r.retrieved_at, media,
      pagination: { has_next_page: hasNext, after: hasNext ? cursor : null } };
  }
  return {
    async connectionStatus(verify = true) {
      let c: Json;
      try { c = await connect(); } catch { return { configured_account: expectedUsername, credentials_configured: false, connection_verified: false, health: 'not_configured', checked_at: new Date().toISOString() }; }
      const base = { configured_account: expectedUsername, credentials_configured: true,
        credential: { saved_at: c.saved_at ?? null, expires_at: c.expires_at ?? null, expiry_source: c.expiry_source ?? null },
        connection_verified: false, checked_at: new Date().toISOString() };
      if (!verify) return sanitize({ ...base, health: 'not_checked' }, c.access_token);
      try { return sanitize({ ...base, account: await identity(c), connection_verified: true, health: 'healthy', verification_scope: 'Authenticated account identity only; listing and insights calls verify their own access.' }, c.access_token); }
      catch (e) { if (!(e instanceof InstagramError)) throw e; return sanitize({ ...base, health: e.code, error: { message: e.message, ...e.details } }, c.access_token); }
    },
    async listRecentMedia(limit = 10, after?: string) {
      const c = await connect(); return sanitize(await page(c, await identity(c), limit, after), c.access_token);
    },
    async getReelInsights(mediaId: string) {
      const c = await connect(); const account = await identity(c);
      let reel = owned.get(`${account.user_id}:${mediaId}`);
      let after: string | undefined;
      for (let i = 0; !reel && i < 5; i++) {
        const result = await page(c, account, 25, after);
        reel = result.media.find((m: Json) => m.id === mediaId);
        after = result.pagination.after ?? undefined;
        if (!after) break;
      }
      if (!reel) throw new InstagramError('ownership_not_verified', 'Reel not found in the first 125 owned posts. List older pages with instagram_list_recent_media, then retry its ID in this server session.');
      if (reel.media_product_type !== 'REELS') throw new InstagramError('not_a_reel', 'The specified owned media is not a Reel. Choose media_product_type REELS from the listing.');
      const results = await Promise.all(metrics.map(async name => {
        const r = await deps.request(c.access_token, `${mediaId}/insights`, { metric: name, period: 'lifetime' });
        return { ...normalize(name, r), unit: name.startsWith('ig_reels_') ? 'milliseconds' : 'count',
          unit_source: 'Meta metric definition; native value, no conversion', http_status: r.http_status, api_version_returned: r.api_version_returned };
      }));
      return sanitize({ account, media: reel, api_version: version, retrieved_at: new Date().toISOString(),
        metrics: [...results, { name: 'follows', status: 'unsupported', value: null, period: null, unit: null, retrieved_at: new Date().toISOString(), reason: 'Meta lists follows for FEED/STORY, not REELS; not requested.' }] }, c.access_token);
    }
  };
}
