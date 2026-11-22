// Runs the site collection once on this computer with the real APIs, into a throwaway local copy of the
// site database (node:sqlite, same schema), and writes the digest's `site` section to a file.
// Nothing is sent to Cloudflare D1 and no Worker secret is used. Tokens are read from the local files
// (site/, youtube/.client.json) and never printed.
//   node scripts/site-local.ts <output.json> [at-ISO-time]
import { readFileSync, writeFileSync } from 'node:fs';
import { runOnce } from '../src/jobs.ts';
import { googleTokenSource } from '../src/site/sources.ts';
import { siteDigest } from '../src/site/digest.ts';
import { FakeD1 } from '../test/d1.ts';
import { root } from './wrangler.ts';

const out = process.argv[2];
if (!out) { console.error('Usage: node scripts/site-local.ts <output.json> [at]'); process.exit(1); }
const at = process.argv[3] ? new Date(process.argv[3]) : new Date();
const text = (p: string) => readFileSync(root + p, 'utf8').trim();
const client = JSON.parse(text('../youtube/.client.json'));
const env: any = { SITE_DB: new FakeD1(undefined, 'site'), SITE_CF_TOKEN: text('../site/.env.cloudflare-token'), SITE_BING_KEY: text('../site/.env.bing-key'),
  SITE_GOOGLE_CREDENTIAL: text('../site/.credentials.json'), YOUTUBE_CLIENT: JSON.stringify(client.installed ?? client),
  SITE_HOST: process.env.SITE_HOST, SITE_CF_ACCOUNT_ID: process.env.SITE_CF_ACCOUNT_ID, SITE_CF_SITE_TAG: process.env.SITE_CF_SITE_TAG, SITE_GA4_PROPERTY: process.env.SITE_GA4_PROPERTY };
const f = (u: string, i?: RequestInit) => fetch(u, i);
const deps: any = { site: () => ({ fetch: f, cfToken: env.SITE_CF_TOKEN, bingKey: env.SITE_BING_KEY, googleToken: googleTokenSource(f, env.YOUTUBE_CLIENT, env.SITE_GOOGLE_CREDENTIAL) }) };

for (let i = 0; i < 12; i++) {
  const r = await runOnce(env, new Date(at.getTime() + i * 1000), deps);
  console.log(JSON.stringify({ action: r.action, done: r.done ?? null, result: r.result ?? null }));
  if (r.action === 'idle') break;
}
const d = await siteDigest(env.SITE_DB, at);
writeFileSync(out, JSON.stringify(d, null, 2) + '\n');
console.log(`site digest written (${d.available ? d.run.status : 'not available'}), problems: ${d.problems?.length ?? 0}`);
