import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialPath = root + '.credentials.json';
export const version = 'v25.0';
export const metrics = ['views', 'reach', 'likes', 'comments', 'saved', 'shares',
  'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];
export type Json = Record<string, any>;
export type Result = { retrieved_at: string; endpoint: string; parameters: Json;
  http_status: number | null; api_version_returned: string | null; body: Json };

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

export async function credentials(): Promise<Json> {
  try {
    const c = JSON.parse(await readFile(credentialPath, 'utf8'));
    if (typeof c.access_token !== 'string' || !c.access_token.trim()) throw new Error();
    await chmod(credentialPath, 0o600);
    return c;
  } catch {
    throw new Error('No usable local credential. Run npm run auth in your own terminal; never paste the token into chat.');
  }
}

export async function saveCredential(c: Json) {
  await writeFile(credentialPath + '.tmp', JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await chmod(credentialPath + '.tmp', 0o600);
  await rename(credentialPath + '.tmp', credentialPath);
}

export async function request(token: string, endpoint: string, parameters: Json = {}): Promise<Result> {
  // Fixed host; never follow API paging URLs or redirects carrying credentials.
  const url = new URL(`https://graph.instagram.com/${version}/${endpoint}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, String(value));
  const result: Result = { retrieved_at: new Date().toISOString(), endpoint, parameters,
    http_status: null, api_version_returned: null, body: {} };
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(25000), redirect: 'error' });
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

export async function saveResponse(value: Json, token: string): Promise<string> {
  await mkdir(root + 'data', { recursive: true, mode: 0o700 });
  const path = root + `data/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(path, JSON.stringify(redact(value, token), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return path;
}
