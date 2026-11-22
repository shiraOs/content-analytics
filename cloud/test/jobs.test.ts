// The Sunday schedule: one piece per fire, in order, with a lease; and the protected endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/jobs.ts';
import type { Deps } from '../src/jobs.ts';
import worker, { authorized } from '../src/index.ts';
import { createYouTubeService } from '../src/youtube/service.ts';
import { createTikTokService } from '../src/tiktok/service.ts';
import { fixture } from './youtube-fixture.ts';
import { fakeEnv } from './d1.ts';
import type { Json } from '../src/shared.ts';

const SUNDAY = new Date('2026-11-08T05:00:00Z');
const reel = (id: string) => ({ id, media_product_type: 'REELS', timestamp: '2026-11-01T10:00:00.000Z', caption: 'c', permalink: null, media_type: 'VIDEO' });
function deps(opts: { reels?: number; ytNetwork?: boolean; token?: Json } = {}): Deps & { calls: string[] } {
  const calls: string[] = [];
  const account = { user_id: '42', username: 'creator.example' };
  const ok = (data: any) => ({ retrieved_at: new Date().toISOString(), endpoint: '', http_status: 200, body: { data, error: { code: 'ok' } } });
  return { calls,
    youtube: () => { calls.push('youtube'); return opts.ytNetwork
      ? createYouTubeService({ credentials: async () => ({ refresh_token: 'r' }), token: async () => { throw Object.assign(new Error('offline'), { code: 'network_error' }); }, request: async () => { throw new Error(); } })
      : fixture().service; },
    tiktok: () => { calls.push('tiktok'); return createTikTokService({ credentials: async () => ({ refresh_token: 'r', open_id: 'O' }), token: async () => 't',
      request: async (_t: string, endpoint: string) => endpoint === 'user/info/' ? ok({ user: { open_id: 'O', username: 'creator.example', follower_count: 35 } }) : ok({ videos: [], has_more: false }) }); },
    instagram: () => ({
      session: async () => ({ c: { access_token: 't' }, account }),
      listRecentMedia: async () => ({ account, media: [...Array(opts.reels ?? 7)].map((_, i) => reel(String(i + 1))), pagination: { has_next_page: false, after: null } }),
      getReelInsights: async (_s: Json, m: Json) => { calls.push('reel:' + m.id); return { account, media: m, api_version: 'v25.0',
        metrics: [{ name: 'views', status: 'available', value: 5, period: 'lifetime', unit: 'count', retrieved_at: new Date().toISOString() }] }; }
    }) as any,
    refreshInstagram: async () => { calls.push('token-check'); return opts.token ?? { status: 'not_due', days_left: 50 }; }
  };
}

test('each fire does one piece: YouTube, TikTok, Instagram listing, then 5 reels at a time, then nothing', async () => {
  const env = fakeEnv(); const d = deps({ reels: 7 });
  const actions = [];
  for (let i = 0; i < 7; i++) { const r = await runOnce(env, new Date(SUNDAY.getTime() + i * 300000), d); actions.push(`${r.platform ?? '-'}:${r.action}`); }
  assert.deepEqual(actions, ['youtube:collect', 'tiktok:collect', 'instagram:discover', 'instagram:reels', 'instagram:reels', '-:idle', '-:idle']);
  assert.deepEqual(d.calls.filter(c => c.startsWith('reel:')).length, 7);
  const ig = await env.INSTAGRAM_DB.prepare("SELECT status,details_json FROM collection_runs WHERE kind='collection'").first<any>();
  assert.equal(ig.status, 'completed'); assert.equal(JSON.parse(ig.details_json).token_check.status, 'not_due');
  const job = await env.INSTAGRAM_DB.prepare('SELECT * FROM cloud_jobs').first<any>();
  assert.equal(job.week, '2026-11-08'); assert.equal(job.status, 'done'); assert.equal(job.lease_until, null);
});
test('a second fire while one is working finds the lease and does nothing', async () => {
  const env = fakeEnv();
  await env.YOUTUBE_DB.prepare("INSERT INTO cloud_jobs VALUES ('2026-11-08','in_progress',1,?,'{}',?)").bind(new Date(SUNDAY.getTime() + 600000).toISOString(), SUNDAY.toISOString()).run();
  const r = await runOnce(env, SUNDAY, deps());
  assert.equal(r.action, 'busy'); assert.equal(r.platform, 'youtube');
  // Once the lease runs out (a crashed fire), the next fire takes over.
  assert.equal((await runOnce(env, new Date(SUNDAY.getTime() + 11 * 60000), deps())).action, 'collect');
});
test('a network failure is tried again on a later fire, at most twice; quota or sign-in failures are not', async () => {
  const env = fakeEnv(); const d = deps({ ytNetwork: true });
  const first = await runOnce(env, SUNDAY, d);
  assert.equal(first.done, false); assert.equal(first.result.stop_reason, 'network_error');
  await runOnce(env, new Date(SUNDAY.getTime() + 300000), d);
  const third = await runOnce(env, new Date(SUNDAY.getTime() + 600000), d);
  assert.equal(third.platform, 'youtube'); assert.equal(third.done, true);
  assert.equal((await runOnce(env, new Date(SUNDAY.getTime() + 900000), d)).platform, 'tiktok');
});
test('the digest endpoint needs the key and never shows a token', async () => {
  const key = 'k'.repeat(40);
  const env = fakeEnv({ DIGEST_KEY: key, INSTAGRAM_CREDENTIAL: JSON.stringify({ access_token: 'IGSECRETTOKEN', saved_at: '2026-11-02T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' }),
    TIKTOK_CREDENTIAL: JSON.stringify({ refresh_token: 'TTSECRET', saved_at: '2026-11-02T00:00:00Z', refresh_expires_at: '2027-11-02T00:00:00Z' }) });
  const d = deps(); for (let i = 0; i < 5; i++) await runOnce(env, new Date(SUNDAY.getTime() + i * 300000), d);
  const call = (path: string, auth?: string, method = 'GET') => worker.fetch(new Request('https://x.workers.dev' + path, { method, headers: auth ? { Authorization: auth } : {} }), env);
  assert.equal((await call('/digest')).status, 401);
  assert.equal((await call('/digest', 'Bearer ' + 'k'.repeat(39) + 'x')).status, 401);
  assert.equal((await call('/other', 'Bearer ' + key)).status, 404);
  const res = await call('/digest', 'Bearer ' + key);
  assert.equal(res.status, 200); assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const text = await res.text(); const body = JSON.parse(text);
  assert.ok(!text.includes('IGSECRETTOKEN') && !text.includes('TTSECRET') && !text.includes(key));
  assert.equal(body.youtube.available, true); assert.equal(body.tiktok.available, true); assert.equal(body.instagram.available, true);
  assert.equal(body.cloud.jobs.instagram.status, 'done'); assert.equal(body.cloud.credentials.instagram.expires_at, '2027-01-01T00:00:00Z');
  assert.ok(body.cloud.problems.includes('No YouTube sign-in stored in the cloud.'));
  assert.equal((await worker.fetch(new Request('https://x/digest'), fakeEnv({ DIGEST_KEY: 'short' }))).status, 503, 'a short key is refused');
  assert.equal(await authorized(new Request('https://x/', { headers: { Authorization: 'Bearer ' + key } }), key), true);
});
test('an expired Instagram token is reported as a problem', async () => {
  const env = fakeEnv(); const d = deps({ reels: 0, token: { status: 'expired', message: 'Token already expired.' } });
  for (let i = 0; i < 3; i++) await runOnce(env, new Date(SUNDAY.getTime() + i * 300000), d);
  const { cloudStatus } = await import('../src/weekly.ts');
  const s = await cloudStatus(env, SUNDAY);
  assert.ok(s.problems.some((p: string) => p.startsWith('Instagram token check expired')));
});
