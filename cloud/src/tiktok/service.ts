// Port of tiktok/src/service.ts (the collector half).
import { credentials, oauthClient, postToken, saveCredential, tokenSource, request, status, errorSummary, redact, num, userFields, videoFields, accountMetrics, videoMetrics, reauth } from './core.ts';
import type { Json, Result } from './core.ts';
import type { Env } from '../shared.ts';

export class TikTokError extends Error {
  code: string;
  details: Json;
  constructor(code: string, message: string, details: Json = {}) {
    super(message); this.code = code; this.details = details;
  }
}
// Public output never includes raw API bodies or URLs carrying credentials.
export function sanitize(value: any): any {
  const clean = redact(value);
  if (typeof clean === 'string') return clean.replace(/https?:\/\/[^\s"<>]+/gi,
    url => /access_token|refresh_token|client_secret|\[REDACTED\]/i.test(url) ? '[credential URL removed]' : url);
  if (Array.isArray(clean)) return clean.map(v => sanitize(v));
  if (clean && typeof clean === 'object') return Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, sanitize(v)]));
  return clean;
}
function requireSuccess(r: Result, operation: string) {
  const s = status(r);
  if (s !== 'available') throw new TikTokError(s, `${operation} failed. ${s === 'quota_exceeded' ? 'TikTok rate limit reached; retry later.' : s === 'authentication_failed' ? reauth : s === 'permission_denied' ? 'A permission was not granted; ' + reauth : 'Check connection status and retry.'}`,
    { ...errorSummary(r), retrieved_at: r.retrieved_at });
}
const observation = (target: string, name: string, value: unknown, retrieved_at: string) =>
  ({ target, name, unit: 'count', status: num(value) === null ? 'missing' : 'available', value: num(value), retrieved_at });

export type TikTokDeps = { credentials: () => Promise<Json>; token: () => Promise<string>; request: typeof request };
export const tiktokDeps = (env: Env): TikTokDeps => {
  const creds = credentials(env.TIKTOK_DB, env.TIKTOK_CREDENTIAL);
  return { credentials: creds, request,
    token: tokenSource({ oauthClient: oauthClient(env), credentials: creds, postToken, saveCredential: saveCredential(env.TIKTOK_DB) }) };
};

export function createTikTokService(deps: TikTokDeps) {
  async function call(endpoint: string, fields: string[], body: Json | undefined, operation: string) {
    let token: string;
    try { token = await deps.token(); }
    catch (e: any) { throw new TikTokError(e?.code ?? 'not_configured', e instanceof Error ? e.message : 'Sign-in unavailable. ' + reauth); }
    const r = await deps.request(token, endpoint, fields, body);
    try { requireSuccess(r, operation); }
    catch (e) { if (e instanceof TikTokError) e.details = redact(e.details, [token]); throw e; }
    return r;
  }
  async function account() {
    let c: Json;
    try { c = await deps.credentials(); } catch { throw new TikTokError('not_configured', 'No usable TikTok sign-in. ' + reauth); }
    const r = await call('user/info/', userFields, undefined, 'Account lookup');
    const u = r.body.data?.user;
    if (!u || typeof u.open_id !== 'string') throw new TikTokError('invalid_response', 'TikTok returned no account for this sign-in.');
    if (c.open_id && u.open_id !== c.open_id) throw new TikTokError('account_mismatch', 'Sign-in now points to a different TikTok account; collection stopped. ' + reauth);
    return { id: u.open_id as string, username: u.username ?? null, display_name: u.display_name ?? null, retrieved_at: r.retrieved_at,
      public: accountMetrics.map(name => observation('account', name, u[name], r.retrieved_at)) };
  }
  // Public posts, newest first. Stops at the lookback cutoff, the end of the list, or the page cap.
  async function listVideos(cutoff: Date, pages = 5) {
    const videos: Json[] = []; const seen = new Set<string>(); let cursor: number | undefined; let complete = false; let pagesRead = 0;
    for (let p = 0; p < pages; p++) {
      const r = await call('video/list/', videoFields, { max_count: 20, ...(cursor !== undefined ? { cursor } : {}) }, 'Video listing');
      pagesRead++;
      const items: Json[] = r.body.data?.videos ?? [];
      let reachedCutoff = false;
      for (const v of items) {
        const created = num(v.create_time);
        if (typeof v.id !== 'string' || seen.has(v.id)) continue;
        if (created === null || created * 1000 < cutoff.getTime()) { reachedCutoff ||= created !== null; continue; }
        seen.add(v.id);
        videos.push({ id: v.id, published_at: new Date(created * 1000).toISOString(), title: v.title || null,
          description: typeof v.video_description === 'string' ? v.video_description.slice(0, 150) : null,
          duration_seconds: num(v.duration), url: typeof v.share_url === 'string' ? v.share_url : null,
          public: videoMetrics.map(name => observation(v.id, name, v[name], r.retrieved_at)) });
      }
      const next = num(r.body.data?.cursor);
      if (reachedCutoff || !r.body.data?.has_more || next === null || next === cursor) { complete = true; break; }
      cursor = next;
    }
    return { videos, discovery_complete: complete, pages: pagesRead };
  }
  return { account, listVideos };
}
export type TikTokService = ReturnType<typeof createTikTokService>;
