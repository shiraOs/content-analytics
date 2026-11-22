// Mirrors instagram/test/{history,core}.test.ts against the D1 port, split into pieces.
import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, batch, finish, defaults } from '../src/instagram/collect.ts';
import type { State } from '../src/instagram/collect.ts';
import { History } from '../src/instagram/history.ts';
import { createInstagramService } from '../src/instagram/service.ts';
import { refreshDecision, refreshIfDue, credentials, status } from '../src/instagram/core.ts';
import { instagramDigest } from '../src/weekly.ts';
import { FakeD1 } from './d1.ts';
import type { Json } from '../src/shared.ts';

const second = '2026-09-10T00:00:00.000Z';
const account = { user_id: '42', username: 'creator.example' };
const media = { id: '1', media_product_type: 'REELS', timestamp: '2026-09-07T00:00:00.000Z' };
const metric = (extra: Json = {}) => ({ name: 'views', status: 'available', value: 10, period: 'lifetime', unit: 'count', retrieved_at: second, ...extra });
const store = () => new History(new FakeD1(undefined, 'instagram'));

function service(mode = '') {
  const calls: string[] = [];
  return { calls,
    session: async () => { if (mode === 'auth') { const { InstagramError } = await import('../src/instagram/service.ts'); throw new InstagramError('authentication_failed', 'expired'); } return { c: { access_token: 't' }, account }; },
    listRecentMedia: async (_s: Json, _limit?: number, after?: string) => {
      if (after && mode === 'page-error') throw new Error('do not persist raw secret');
      return { account, media: [{ ...media, id: after ? '3' : '1' }, { ...media, id: after ? '4' : '2' }], pagination: { has_next_page: !after, after: !after ? 'next' : null } };
    },
    getReelInsights: async (_s: Json, reel: Json) => {
      calls.push(reel.id);
      return { account, media: reel, api_version: 'v25.0', metrics: [metric(), metric({ name: 'reach', status: 'missing', value: null }),
        ...(mode === 'rate' ? [metric({ name: 'likes', status: 'error', http_status: 429, error: { code: 4 }, value: null })] : [])] };
    } } as any;
}
async function all(st: History, s: any, options = defaults, size = 5) {
  let state: State = await discover(st, s, options, new Date(second));
  while (state.queue.length) state = await batch(st, s, state, size);
  return finish(st, state);
}
const count = async (st: History, sql: string) => (await st.db.prepare(sql).first<any>())!.n;

test('a run spans discovery and batches; partial metrics and a page failure keep earlier snapshots', async () => {
  const st = store(); const s = service('page-error'); const r = await all(st, s);
  assert.equal(r.status, 'partial'); assert.equal(r.pages, 1); assert.equal(r.items.length, 2); assert.equal(r.items[0].status, 'partial');
  assert.deepEqual(s.calls, ['1', '2']);
  assert.equal(await count(st, "SELECT count(*) AS n FROM metric_snapshots WHERE media_id='1'"), 2);
  assert.equal((await st.db.prepare("SELECT value_json FROM metric_snapshots WHERE name='reach'").first<any>()).value_json, 'null', 'missing is not zero');
  assert.equal(await count(st, "SELECT count(*) AS n FROM collection_runs WHERE status='partial'"), 1);
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('rate limiting stops the remaining reels without retries or discarding completed metrics', async () => {
  const st = store(); const s = service('rate'); const r = await all(st, s);
  assert.equal(r.stop_reason, 'rate_limited'); assert.equal(r.status, 'partial'); assert.deepEqual(s.calls, ['1']);
  assert.equal(await count(st, 'SELECT count(*) AS n FROM metric_snapshots'), 3);
});
test('reels are fetched 5 per piece; caps and cutoff hold', async () => {
  const st = store(); const s = service();
  s.listRecentMedia = async (_s: Json, _l: number, after?: string) => ({ account, media: after ? [] : [...Array(12)].map((_, i) => ({ ...media, id: String(i + 1) })).concat([{ ...media, id: 'old', timestamp: '2020-01-01T00:00:00Z' }]),
    pagination: { has_next_page: false, after: null } });
  let state = await discover(st, s, defaults, new Date(second));
  assert.equal(state.queue.length, 12);
  state = await batch(st, s, state); assert.equal(s.calls.length, 5); assert.equal(state.queue.length, 7);
  state = await batch(st, s, state); state = await batch(st, s, state);
  const r = await finish(st, state);
  assert.equal(r.status, 'partial', 'reach is missing in this fake, so each reel is partial'); assert.equal(r.counts.partial, 12); assert.equal(s.calls.length, 12);
  const capped = await discover(store(), s, { ...defaults, reels: 1 }, new Date(second));
  assert.equal(capped.summary.stop_reason, 'reel_limit'); assert.equal(capped.queue.length, 1);
});
test('page cap is reported, not claimed complete', async () => {
  const r = await all(store(), service(), { ...defaults, pages: 1 });
  assert.equal(r.stop_reason, 'page_limit'); assert.equal(r.discovery_complete, false);
});
test('a rejected sign-in stops before any reel is fetched', async () => {
  const st = store(); const s = service('auth'); const r = await all(st, s);
  assert.equal(r.stop_reason, 'authentication_failed'); assert.equal(r.status, 'partial'); assert.equal(s.calls.length, 0);
});
test('one batch of 5 reels stays within the 50-call free-plan limit with the real service', async () => {
  let calls = 0;
  const svc = createInstagramService({ username: 'creator.example', credentials: async () => ({ access_token: 'tok-SECRET' }),
    request: async (_t: string, endpoint: string, params: Json = {}) => {
      calls++;
      const body = endpoint === 'me' ? { user_id: '42', username: 'creator.example' } : { data: [{ name: params.metric, period: 'lifetime', values: [{ value: 3 }] }] };
      return { retrieved_at: second, endpoint, parameters: params, http_status: 200, api_version_returned: null, body };
    } });
  const st = store();
  const run = await st.start('collection', {});
  await st.commit([...st.media(account, media), ...[2, 3, 4, 5].flatMap(i => st.media(account, { ...media, id: String(i) }))]);
  const state = await batch(st, svc, { run_id: run, summary: { items: [] }, queue: [1, 2, 3, 4, 5, 6].map(i => ({ ...media, id: String(i) })) });
  assert.equal(calls, 1 + 5 * 8); assert.equal(state.queue.length, 1);
  assert.equal(await count(st, "SELECT count(*) AS n FROM run_items WHERE status='succeeded'"), 5);
});
test('weekly digest reads reels and week-ago change', async () => {
  const st = store(); const s = service();
  await all(st, s);
  const d = await instagramDigest(st.db, new Date(second));
  assert.equal(d.available, true); assert.equal(d.reels.length, 4); assert.equal(d.reels[0].latest.views, 10);
  assert.equal((await instagramDigest(new FakeD1())).available, false);
});

const DAY = 86400000;
test('refresh-if-due renews only with 20 days or fewer left and a token at least 24 hours old', () => {
  const at = Date.parse('2026-12-15T00:00:00Z');
  const c = (left: number | null, ageHours = 1000) => ({ expires_at: left === null ? null : new Date(at + left * DAY).toISOString(), saved_at: new Date(at - ageHours * 3600000).toISOString() });
  assert.equal(refreshDecision(c(40), at).action, 'skip');
  assert.equal(refreshDecision(c(20), at).action, 'renew');
  assert.equal(refreshDecision(c(null), at).action, 'renew', 'unknown expiry is renewed');
  assert.equal(refreshDecision(c(10, 2), at).action, 'skip', 'under 24 hours old');
  assert.equal(refreshDecision(c(-1), at).action, 'expired');
});
test('a renewed token is stored in D1 and used from then on; failures keep the old one', async () => {
  const db = new FakeD1(undefined, 'instagram');
  const at = Date.parse('2026-12-15T00:00:00Z');
  const secret = JSON.stringify({ access_token: 'old-token-aaaaaaaaaaaaaaaa', saved_at: '2026-11-02T00:00:00Z', expires_at: '2027-01-01T00:00:00Z' });
  let seen = '';
  const ok = (async (url: URL) => { seen = String(url); return new Response(JSON.stringify({ access_token: 'new-token-bbbbbbbbbbbbbbbb', expires_in: 5184000 })); }) as any;
  const r = await refreshIfDue(db, secret, ok, at);
  assert.equal(r.status, 'renewed'); assert.ok(!JSON.stringify(r).includes('token-'), 'result never carries a token');
  assert.ok(seen.includes('ig_refresh_token'));
  assert.equal((await credentials(db, secret)()).access_token, 'new-token-bbbbbbbbbbbbbbbb');
  assert.equal((await refreshIfDue(db, secret, ok, at)).status, 'not_due');
  const db2 = new FakeD1(undefined, 'instagram');
  const bad = (async () => new Response(JSON.stringify({ error: { code: 190 } }), { status: 400 })) as any;
  assert.equal((await refreshIfDue(db2, secret, bad, at)).status, 'failed');
  assert.equal((await credentials(db2, secret)()).access_token, 'old-token-aaaaaaaaaaaaaaaa');
});
test('status keeps missing, unsupported and auth failures apart', () => {
  const r = (http_status: number | null, error?: Json) => ({ retrieved_at: '', endpoint: '', parameters: {}, http_status, api_version_returned: null, body: error ? { error } : {} });
  assert.equal(status(r(200)), 'available');
  assert.equal(status(r(400, { code: 190 })), 'authentication_failed');
  assert.equal(status(r(400, { message: 'Not enough viewers' })), 'missing');
  assert.equal(status(r(400, { message: 'metric not supported' })), 'unsupported');
  assert.equal(status(r(400, { code: 100, message: 'bad object' })), 'error');
});
