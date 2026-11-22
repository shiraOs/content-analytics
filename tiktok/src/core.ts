import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const clientPath = root + '.client.json';
export const credentialPath = root + '.credentials.json';
export const scopes = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];
export const authorizeUrl = 'https://www.tiktok.com/v2/auth/authorize/';
export const tokenUrl = 'https://open.tiktokapis.com/v2/oauth/token/';
// Fixed host only; requests never follow redirects or caller-supplied URLs.
export const apiHost = 'https://open.tiktokapis.com/v2/';
export const userFields = ['open_id', 'display_name', 'username', 'follower_count', 'following_count', 'likes_count', 'video_count'];
export const videoFields = ['id', 'create_time', 'title', 'video_description', 'duration', 'share_url', 'view_count', 'like_count', 'comment_count', 'share_count'];
// All TikTok numbers are lifetime counters; only follower/following/video counts can also go down.
export const accountMetrics = ['follower_count', 'following_count', 'likes_count', 'video_count'];
export const videoMetrics = ['view_count', 'like_count', 'comment_count', 'share_count'];
export type Json = Record<string, any>;
export type Result = { retrieved_at: string; endpoint: string; http_status: number | null; body: Json };

// TikTok's desktop PKCE uses the hex SHA-256 of the verifier, not RFC 7636 base64url.
export const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('hex');

// Not "code": TikTok reports success as error.code === "ok", so hiding it would turn every answer into a failure.
const secretKeys = /^(access_token|refresh_token|client_secret|code_verifier)$/i;
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

export async function oauthClient(): Promise<{ client_key: string; client_secret: string }> {
  try {
    const c = JSON.parse(await readFile(clientPath, 'utf8'));
    if (typeof c.client_key !== 'string' || typeof c.client_secret !== 'string') throw new Error();
    await chmod(clientPath, 0o600);
    return { client_key: c.client_key, client_secret: c.client_secret };
  } catch {
    throw new Error(`No usable TikTok app keys. Save {"client_key": "...", "client_secret": "..."} from the TikTok developer portal as ${clientPath}.`);
  }
}

export async function credentials(): Promise<Json> {
  try {
    const c = JSON.parse(await readFile(credentialPath, 'utf8'));
    if (typeof c.refresh_token !== 'string' || !c.refresh_token.trim()) throw new Error();
    await chmod(credentialPath, 0o600);
    return c;
  } catch {
    throw new Error('No usable local credential. Run npm run auth in your own terminal; never paste tokens into chat.');
  }
}

export async function saveCredential(c: Json) {
  await writeFile(credentialPath + '.tmp', JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await chmod(credentialPath + '.tmp', 0o600);
  await rename(credentialPath + '.tmp', credentialPath);
}

export async function postToken(form: Json): Promise<{ http_status: number | null; body: Json }> {
  try {
    const response = await fetch(tokenUrl, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    let body: Json;
    try { body = await response.json() as Json; } catch { body = { error: 'non_json' }; }
    return { http_status: response.status, body };
  } catch {
    return { http_status: null, body: { error: 'network_error' } };
  }
}

// Access tokens (24 h) stay in memory. TikTok may rotate the refresh token on every refresh,
// so a changed one is written back before it is used again.
export function tokenSource(deps = { oauthClient, credentials, postToken, saveCredential }) {
  let cached: { token: string; expires: number } | null = null;
  return async (): Promise<string> => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const [client, c] = await Promise.all([deps.oauthClient(), deps.credentials()]);
    const r = await deps.postToken({ ...client, refresh_token: c.refresh_token, grant_type: 'refresh_token' });
    if (r.body.error === 'invalid_grant') throw Object.assign(new Error('TikTok rejected the saved sign-in (expired or revoked). Run npm run auth again.'), { code: 'authentication_failed' });
    if (typeof r.body.access_token !== 'string') throw Object.assign(new Error('Could not refresh the TikTok access token. Check the network and retry.'), { code: r.http_status === null ? 'network_error' : 'authentication_failed' });
    if (typeof r.body.refresh_token === 'string' && r.body.refresh_token !== c.refresh_token) {
      await deps.saveCredential({ ...c, refresh_token: r.body.refresh_token,
        refresh_expires_at: Number(r.body.refresh_expires_in) ? new Date(Date.now() + Number(r.body.refresh_expires_in) * 1000).toISOString() : c.refresh_expires_at ?? null,
        rotated_at: new Date().toISOString() });
    }
    cached = { token: r.body.access_token, expires: Date.now() + (Number(r.body.expires_in) || 86400) * 1000 };
    return cached.token;
  };
}

export async function request(token: string, endpoint: string, fields: string[], body?: Json): Promise<Result> {
  const url = new URL(endpoint, apiHost);
  url.searchParams.set('fields', fields.join(','));
  const result: Result = { retrieved_at: new Date().toISOString(), endpoint, http_status: null, body: {} };
  try {
    const response = await fetch(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    result.http_status = response.status;
    try { result.body = redact(await response.json(), [token]); }
    catch { result.body = { error: { code: 'non_json', message: 'Non-JSON response from TikTok' } }; }
  } catch {
    result.body = { error: { code: 'network_error', message: 'Network request failed or timed out; check connectivity and retry.' } };
  }
  return result;
}

// TikTok answers {data, error: {code, message, log_id}} with code "ok" on success.
export function status(result: Result): string {
  const code = String(result.body.error?.code ?? '');
  if (result.http_status === null) return 'network_error';
  if (code === 'ok' && result.http_status >= 200 && result.http_status < 300) return 'available';
  if (result.http_status === 429 || code === 'rate_limit_exceeded') return 'quota_exceeded';
  if (result.http_status === 401 || /access_token_invalid|access_token_expired/.test(code)) return 'authentication_failed';
  if (code === 'scope_not_authorized' || code === 'scope_permission_missed') return 'permission_denied';
  if (result.http_status === 403) return 'permission_denied';
  if (result.http_status === 400 || code === 'invalid_params') return 'bad_request';
  return 'error';
}

export function errorSummary(result: Result): Json {
  const e = result.body.error ?? {};
  return { http_status: result.http_status, reason: e.code ?? null, log_id: e.log_id ?? null,
    message: typeof e.message === 'string' ? e.message.slice(0, 300) : null };
}

export const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
