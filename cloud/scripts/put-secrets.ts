// Copies the local sign-ins into the Worker's secrets, without printing them.
//   npm run secrets                 all nine secrets
//   npm run secrets -- TIKTOK_CREDENTIAL   just one (after a new sign-in on your computer)
// Only the fields the Worker needs are sent. Values go to wrangler on stdin; wrangler's own output is
// not shown. DIGEST_KEY is made once and kept in .env.digest-key (0600, git-ignored) for the cloud routine.
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { wrangler, root } from './wrangler.ts';

const read = (path: string) => JSON.parse(readFileSync(root + path, 'utf8'));
const pick = (o: any, keys: string[]) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));
const need = (o: any, keys: string[], what: string) => { for (const k of keys) if (typeof o[k] !== 'string' || !o[k]) throw new Error(`${what} has no ${k}. Sign in on your computer first.`); return o; };
export const keyPath = root + '.env.digest-key';

const secrets: Record<string, () => string> = {
  YOUTUBE_CLIENT: () => { const raw = read('../youtube/.client.json'); return JSON.stringify(need(pick(raw.installed ?? raw, ['client_id', 'client_secret']), ['client_id', 'client_secret'], 'youtube/.client.json')); },
  YOUTUBE_CREDENTIAL: () => JSON.stringify(need(pick(read('../youtube/.credentials.json'), ['refresh_token', 'channel_id', 'channel_title', 'saved_at']), ['refresh_token', 'channel_id'], 'youtube/.credentials.json')),
  INSTAGRAM_CREDENTIAL: () => JSON.stringify(need(pick(read('../instagram/.credentials.json'), ['access_token', 'source', 'saved_at', 'expires_at', 'expiry_source']), ['access_token'], 'instagram/.credentials.json')),
  TIKTOK_CLIENT: () => JSON.stringify(need(pick(read('../tiktok/.client.json'), ['client_key', 'client_secret']), ['client_key', 'client_secret'], 'tiktok/.client.json')),
  TIKTOK_CREDENTIAL: () => JSON.stringify(need(pick(read('../tiktok/.credentials.json'), ['refresh_token', 'open_id', 'username', 'scope', 'refresh_expires_at', 'saved_at', 'rotated_at']), ['refresh_token', 'open_id'], 'tiktok/.credentials.json')),
  SITE_CF_TOKEN: () => { const t = readFileSync(root + '../site/.env.cloudflare-token', 'utf8').trim(); if (!t) throw new Error('site/.env.cloudflare-token is empty.'); return t; },
  SITE_GOOGLE_CREDENTIAL: () => JSON.stringify(need(pick(read('../site/.credentials.json'), ['refresh_token', 'scope', 'saved_at']), ['refresh_token'], 'site/.credentials.json')),
  SITE_BING_KEY: () => { const t = readFileSync(root + '../site/.env.bing-key', 'utf8').trim(); if (!t) throw new Error('site/.env.bing-key is empty.'); return t; },
  DIGEST_KEY: () => {
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(48).toString('base64url') + '\n', { mode: 0o600, flag: 'wx' });
    chmodSync(keyPath, 0o600);
    return readFileSync(keyPath, 'utf8').trim();
  }
};

const only = process.argv.slice(2).filter(a => !a.startsWith('-'));
for (const name of only) if (!secrets[name]) { console.error(`Unknown secret ${name}. Known: ${Object.keys(secrets).join(', ')}`); process.exit(1); }
for (const [name, value] of Object.entries(secrets)) {
  if (only.length && !only.includes(name)) continue;
  let v: string;
  try { v = value(); } catch (e) { console.error(`${name}: not sent — ${e instanceof Error && !/[{"]/.test(e.message) ? e.message : 'could not read the local file'}`); process.exitCode = 1; continue; }
  const r = await wrangler(['secret', 'put', name], v);
  const said = (r.out + r.err).split(v).join('[hidden]');
  console.log(`${name}: ${r.code === 0 ? 'saved in Cloudflare' : 'failed — ' + (said.trim().split('\n').filter(l => /error|✘/i.test(l)).slice(0, 2).join(' ') || 'wrangler exit ' + r.code)}`);
  if (r.code !== 0) process.exitCode = 1;
}
