// Google sign-in for the site numbers (Search Console + Google Analytics 4), read-only.
// Reuses the Desktop-app OAuth client of ../youtube (same Google Cloud project), but keeps its own
// sign-in in .credentials.json here, so the YouTube sign-in is never touched.
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('..', import.meta.url));
export const clientPath = root + '../youtube/.client.json';
export const credentialPath = root + '.credentials.json';
export const tokenUrl = 'https://oauth2.googleapis.com/token';
export const scopes = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly'
];

export type Client = { client_id: string; client_secret: string };
export type Credential = { refresh_token: string; scope: string[]; saved_at: string };

export async function oauthClient(): Promise<Client> {
  let raw: any;
  try { raw = JSON.parse(await readFile(clientPath, 'utf8')); } catch { throw new Error('youtube/.client.json is missing or unreadable.'); }
  const c = raw.installed ?? raw;
  if (typeof c.client_id !== 'string' || typeof c.client_secret !== 'string') throw new Error('youtube/.client.json has no client_id / client_secret.');
  return { client_id: c.client_id, client_secret: c.client_secret };
}

export async function postToken(params: Record<string, string>): Promise<{ http_status: number | null; body: any }> {
  try {
    const r = await fetch(tokenUrl, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { http_status: r.status, body: await r.json().catch(() => ({})) };
  } catch { return { http_status: null, body: {} }; }
}

export async function saveCredential(c: Credential): Promise<void> {
  const tmp = credentialPath + '.tmp';
  await writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, credentialPath);
}

export async function loadCredential(): Promise<Credential> {
  let c: any;
  try { c = JSON.parse(await readFile(credentialPath, 'utf8')); } catch { throw new Error('Not signed in yet. Run npm run auth in site/.'); }
  if (typeof c.refresh_token !== 'string' || !c.refresh_token) throw new Error('Saved sign-in is incomplete. Run npm run auth again.');
  return c;
}

// Short-lived access tokens stay in memory only.
export async function accessToken(): Promise<string> {
  const [client, cred] = await Promise.all([oauthClient(), loadCredential()]);
  const r = await postToken({ ...client, refresh_token: cred.refresh_token, grant_type: 'refresh_token' });
  if (typeof r.body.access_token !== 'string') {
    throw new Error(r.http_status === null ? 'Network error while refreshing the Google sign-in.'
      : r.body.error === 'invalid_grant' ? 'The Google sign-in expired or was revoked. Run npm run auth again.'
      : `Google refused the sign-in (HTTP ${r.http_status}${typeof r.body.error === 'string' ? ', ' + r.body.error : ''}).`);
  }
  return r.body.access_token;
}

export async function getJson(token: string, url: string, body?: unknown): Promise<{ http_status: number | null; body: any }> {
  try {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { http_status: r.status, body: await r.json().catch(() => ({})) };
  } catch { return { http_status: null, body: {} }; }
}
