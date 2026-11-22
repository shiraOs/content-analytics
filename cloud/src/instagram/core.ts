// Port of instagram/src/core.ts and the refresh-if-due part of src/auth.ts.
// The token comes from D1 (once renewed) or the INSTAGRAM_CREDENTIAL secret, whichever was saved last.
import { loadCredential, storeCredential, DAY } from '../shared.ts';
import type { Json, D1Database } from '../shared.ts';
export type { Json };

export const version = 'v25.0';
export const metrics = ['views', 'reach', 'likes', 'comments', 'saved', 'shares',
  'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
export type Result = { retrieved_at: string; endpoint: string; parameters: Json;
  http_status: number | null; api_version_returned: string | null; body: Json };
export const reauth = 'Generate a new dashboard token, run npm run auth in instagram/ on your computer, then npm run secrets in cloud/.';

export function redact(value: any, token = ''): any {
  if (typeof value === 'string') {
    let safe = token ? value.split(token).join('[REDACTED]') : value;
    return safe.replace(/((?:access_token|client_secret|appsecret_proof)=)[^&\s"']+/gi, '$1[REDACTED]');
  }
  if (Array.isArray(value)) return value.map(v => redact(v, token));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([k, v]) => [k, /^(access_token|client_secret|appsecret_proof)$/i.test(k) ? '[REDACTED]' : redact(v, token)]));
  return value;
}

export function credentials(db: D1Database, secret?: string) {
  return async (): Promise<Json> => {
    const c = await loadCredential(db, 'instagram', secret);
    if (typeof c?.access_token !== 'string' || !c.access_token.trim()) throw new Error('No usable Instagram token. ' + reauth);
    return c;
  };
}

export async function request(token: string, endpoint: string, parameters: Json = {}): Promise<Result> {
  // Fixed host; never follow API paging URLs or redirects carrying credentials.
  const url = new URL(`https://graph.instagram.com/${version}/${endpoint}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const result: Result = { retrieved_at: new Date().toISOString(), endpoint, parameters,
    http_status: null, api_version_returned: null, body: {} };
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25000), redirect: 'manual' });
    result.http_status = response.status;
    result.api_version_returned = response.headers.get('facebook-api-version');
    try { result.body = redact(await response.json(), token); }
    catch { result.body = { error: { message: 'Non-JSON response from Meta' } }; }
  } catch {
    result.body = { error: { message: 'Network request failed or timed out; check connectivity and retry.' } };
  }
  return result;
}

export function status(result: Result): string {
  const e = result.body.error;
  if (!e && result.http_status !== null && result.http_status >= 200 && result.http_status < 300) return 'available';
  if (e?.code === 190 || result.http_status === 401) return 'authentication_failed';
  const message = String(e?.message ?? '');
  if (/not enough viewers|not (?:yet )?available|no insights data/i.test(message)) return 'missing';
  if (e?.code === 10 || e?.code === 200 || result.http_status === 403) return 'permission_denied';
  // A generic code 100 can mean a bad object or parameter; do not label all such errors unsupported.
  if (/metric/i.test(message) && /not supported|unsupported|must be one of|invalid metric/i.test(message)) return 'unsupported';
  return 'error';
}

export function normalize(name: string, result: Result): Json {
  const state = status(result);
  const base = { name, status: state, value: null, period: null, retrieved_at: result.retrieved_at };
  if (state !== 'available') return { ...base, error: result.body.error ?? { message: 'HTTP request failed' } };
  const datum = result.body.data?.find((d: Json) => d.name === name);
  const value = datum?.total_value?.value ?? datum?.values?.[0]?.value;
  return { ...base, status: value === undefined || value === null ? 'missing' : 'available',
    value: value ?? null, period: datum?.period ?? null,
    title: datum?.title ?? null, description: datum?.description ?? null,
    values: datum?.values ?? null, total_value: datum?.total_value ?? null };
}

// Same rule as `npm run refresh-if-due`: renew only when 20 days or fewer are left (or the expiry is
// unknown) and the token is at least 24 hours old, as Meta requires. Each renewal adds 60 days.
export function refreshDecision(c: Json, at = Date.now()): { action: 'renew' | 'skip' | 'expired'; days_left: number | null; reason: string } {
  const left = c.expires_at ? (Date.parse(c.expires_at) - at) / DAY : null;
  const age = c.saved_at ? (at - Date.parse(c.saved_at)) / 3600000 : null;
  const days_left = left === null ? null : Math.floor(left);
  if (left !== null && left <= 0) return { action: 'expired', days_left, reason: 'Token already expired; refresh is no longer possible. ' + reauth };
  if (left !== null && left > 20) return { action: 'skip', days_left, reason: `Token not due: ${days_left} days left (expires ${c.expires_at}).` };
  if (age !== null && age < 24) return { action: 'skip', days_left, reason: 'Token is under 24 hours old; Meta does not allow a refresh yet.' };
  return { action: 'renew', days_left, reason: 'Renewal due.' };
}

// Renews when due and stores the new token in D1 before anything uses it. Never logs the URL or response.
export async function refreshIfDue(db: D1Database, secret?: string, fetcher: typeof fetch = fetch, at = Date.now()): Promise<Json> {
  const c = await credentials(db, secret)();
  const d = refreshDecision(c, at);
  if (d.action === 'expired') return { status: 'expired', days_left: d.days_left, message: d.reason };
  if (d.action === 'skip') return { status: 'not_due', days_left: d.days_left, expires_at: c.expires_at ?? null, message: d.reason };
  const url = new URL('https://graph.instagram.com/refresh_access_token');
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', c.access_token);
  let response: Response;
  try { response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(25000) }); }
  catch { return { status: 'failed', message: 'Refresh network request failed. Existing token kept.' }; }
  let body: any;
  try { body = await response.json(); } catch { return { status: 'failed', message: 'Refresh returned non-JSON. Existing token kept.' }; }
  if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in))
    return { status: 'failed', message: 'Meta rejected refresh. Token must be unexpired and at least 24 hours old, with basic permission. Existing token kept.' };
  const expires_at = new Date(at + body.expires_in * 1000).toISOString();
  await storeCredential(db, 'instagram', { access_token: body.access_token, source: 'refresh', saved_at: new Date(at).toISOString(),
    expires_at, expiry_source: 'Meta expires_in' });
  return { status: 'renewed', expires_at, days_left: Math.floor(body.expires_in / 86400), message: 'Refreshed token saved in D1.' };
}
