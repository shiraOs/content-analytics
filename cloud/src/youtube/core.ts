// Port of youtube/src/core.ts for Workers: the OAuth client and refresh token come from
// Worker secrets instead of files. Everything else keeps the local collector's behavior.
import { parseSecret } from '../shared.ts';
import type { Json, Env } from '../shared.ts';
export type { Json };

export const tokenUrl = 'https://oauth2.googleapis.com/token';
// Fixed hosts only; requests never follow redirects or caller-supplied URLs. Workers reject
// redirect: "error", so "manual" is used: a 3xx comes back as a non-2xx answer and counts as a failure.
export const hosts = { data: 'https://www.googleapis.com/youtube/v3/', analytics: 'https://youtubeanalytics.googleapis.com/v2/' } as const;
export const analyticsMetrics = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage',
  'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'];
export const units: Record<string, string> = { estimatedMinutesWatched: 'minutes', averageViewDuration: 'seconds',
  averageViewPercentage: 'percent', duration: 'seconds' };
export const unit = (name: string) => units[name] ?? 'count';
// Lifetime counters can be subtracted between snapshots; averages and public rounded totals cannot.
export const counters = ['views', 'estimatedMinutesWatched', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares',
  'viewCount', 'likeCount', 'commentCount', 'videoCount'];
export type Result = { retrieved_at: string; endpoint: string; parameters: Json; http_status: number | null; body: Json };
export const reauth = 'Run npm run auth in youtube/ on your computer, then npm run secrets in cloud/.';

const secretKeys = /^(access_token|refresh_token|client_secret|id_token|code_verifier)$/i;
export function redact(value: any, secrets: string[] = []): any {
  if (typeof value === 'string') {
    let safe = value;
    for (const s of secrets) if (s) safe = safe.split(s).join('[REDACTED]');
    return safe.replace(/((?:access_token|refresh_token|client_secret)=)[^&\s"']+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [k, secretKeys.test(k) ? '[REDACTED]' : redact(v, secrets)]));
  return value;
}

export function oauthClient(env: Env) {
  return async (): Promise<{ client_id: string; client_secret: string }> => {
    const raw = parseSecret(env.YOUTUBE_CLIENT);
    const c = raw?.installed ?? raw;
    if (typeof c?.client_id !== 'string' || typeof c?.client_secret !== 'string')
      throw new Error('No usable OAuth client in the YOUTUBE_CLIENT secret. Run npm run secrets in cloud/.');
    return { client_id: c.client_id, client_secret: c.client_secret };
  };
}

export function credentials(env: Env) {
  return async (): Promise<Json> => {
    const c = parseSecret(env.YOUTUBE_CREDENTIAL);
    if (typeof c?.refresh_token !== 'string' || !c.refresh_token.trim()) throw new Error('No usable YouTube sign-in in the YOUTUBE_CREDENTIAL secret. ' + reauth);
    return c;
  };
}

export async function postToken(form: Json): Promise<{ http_status: number | null; body: Json }> {
  try {
    const response = await fetch(tokenUrl, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    let body: Json;
    try { body = await response.json() as Json; } catch { body = { error: 'non_json' }; }
    return { http_status: response.status, body };
  } catch {
    return { http_status: null, body: { error: 'network_error' } };
  }
}

// A fresh access token every run, kept in memory only; Google's refresh token does not rotate.
export function tokenSource(deps: { oauthClient: () => Promise<{ client_id: string; client_secret: string }>; credentials: () => Promise<Json>; postToken: typeof postToken }) {
  let cached: { token: string; expires: number } | null = null;
  return async (): Promise<string> => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const [client, c] = await Promise.all([deps.oauthClient(), deps.credentials()]);
    const r = await deps.postToken({ ...client, refresh_token: c.refresh_token, grant_type: 'refresh_token' });
    if (r.body.error === 'invalid_grant') throw Object.assign(new Error('Google rejected the saved sign-in (expired or revoked). ' + reauth), { code: 'authentication_failed' });
    if (typeof r.body.access_token !== 'string') throw Object.assign(new Error('Could not refresh the Google access token. Check the network and retry.'), { code: r.http_status === null ? 'network_error' : 'authentication_failed' });
    cached = { token: r.body.access_token, expires: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 };
    return cached.token;
  };
}

export async function request(token: string, host: keyof typeof hosts, endpoint: string, parameters: Json = {}): Promise<Result> {
  const url = new URL(endpoint, hosts[host]);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const result: Result = { retrieved_at: new Date().toISOString(), endpoint: `${host}:${endpoint}`, parameters, http_status: null, body: {} };
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000), redirect: 'manual' });
    result.http_status = response.status;
    try { result.body = redact(await response.json(), [token]); }
    catch { result.body = { error: { message: 'Non-JSON response from Google' } }; }
  } catch {
    result.body = { error: { message: 'Network request failed or timed out; check connectivity and retry.' } };
  }
  return result;
}

export function status(result: Result): string {
  const e = result.body.error;
  if (!e && result.http_status !== null && result.http_status >= 200 && result.http_status < 300) return 'available';
  if (result.http_status === null) return 'network_error';
  if (result.http_status === 401) return 'authentication_failed';
  const reasons = (e?.errors ?? []).map((x: Json) => String(x.reason ?? '')).join(' ') + ' ' + String(e?.status ?? '');
  if (result.http_status === 429 || /quotaExceeded|rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(reasons)) return 'quota_exceeded';
  if (result.http_status === 403) return 'permission_denied';
  if (result.http_status === 400) return 'bad_request';
  return 'error';
}

export function errorSummary(result: Result): Json {
  const e = result.body.error ?? {};
  return { http_status: result.http_status, reason: e.errors?.[0]?.reason ?? e.status ?? null,
    message: typeof e.message === 'string' ? e.message.slice(0, 300) : null };
}

// Analytics reports return {columnHeaders:[{name}], rows:[[...]]}; map rows to objects by header name.
export function rows(body: Json): Json[] {
  const names: string[] = (body.columnHeaders ?? []).map((h: Json) => h.name);
  return (body.rows ?? []).map((r: any[]) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
}

// ISO 8601 durations from the Data API, e.g. PT1H2M3S, P0D.
export function seconds(iso: unknown): number | null {
  const m = typeof iso === 'string' ? /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso) : null;
  if (!m) return null;
  const [, d, h, min, s] = m.map(x => Number(x ?? 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}

export const day = (d: Date) => d.toISOString().slice(0, 10);
