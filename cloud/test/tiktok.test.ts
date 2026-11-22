// Mirrors tiktok/test/{collect,core}.test.ts against the D1 port, plus token rotation into D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collect } from '../src/tiktok/collect.ts';
import { History } from '../src/tiktok/history.ts';
import { createTikTokService } from '../src/tiktok/service.ts';
import { status, tokenSource, redact, credentials, saveCredential } from '../src/tiktok/core.ts';
import { tiktokDigest } from '../src/weekly.ts';
import { FakeD1 } from './d1.ts';

const secret = 'act.SECRET-ACCESS-TOKEN';
const AT = new Date('2026-10-18T05:00:00Z');
const sec = (iso: string) => Date.parse(iso) / 1000;
const ok = (data: any, http_status = 200) => ({ retrieved_at: new Date().toISOString(), endpoint: '', http_status, body: { data, error: { code: 'ok', message: '', log_id: 'x' } } });
const pages: any[] = [
  { videos: [
    { id: 'v3', create_time: sec('2026-10-15T10:00:00Z'), title: '', video_description: 'deleted chat', share_url: 'https://www.tiktok.com/@creator.example/video/v3', duration: 40, view_count: 900, like_count: 30, comment_count: 2, share_count: 12 },
    { id: 'v2', create_time: sec('2026-10-01T10:00:00Z'), title: 'domain', view_count: 300, like_count: 10, comment_count: 1, share_count: 0 }],
    cursor: 1759312800000, has_more: true },
  { videos: [
    { id: 'v1', create_time: sec('2026-09-20T10:00:00Z'), title: 'tokens', view_count: 200, like_count: 5, comment_count: 0, share_count: 1 },
    { id: 'old', create_time: sec('2026-05-21T10:00:00Z'), title: 'london', view_count: 186, like_count: 1, comment_count: 0, share_count: 0 }],
    cursor: 1747821600000, has_more: true }];

function fake(opts: { followers?: number; views?: number; failList?: string; openId?: string } = {}) {
  const calls: string[] = [];
  const service = createTikTokService({
    credentials: async () => ({ refresh_token: 'r', open_id: 'OPEN1' }),
    token: async () => secret,
    request: async (_t: string, endpoint: string, _f: string[], body?: any) => {
      calls.push(endpoint);
      if (endpoint === 'user/info/') return ok({ user: { open_id: opts.openId ?? 'OPEN1', username: 'creator.example', display_name: 'Creator', follower_count: opts.followers ?? 9, following_count: 3, likes_count: 30, video_count: 5 } });
      if (opts.failList) return { retrieved_at: new Date().toISOString(), endpoint, http_status: 429, body: { error: { code: opts.failList, message: `slow down ${secret}`, log_id: 'y' } } };
      const page = structuredClone(pages[body?.cursor ? 1 : 0]);
      if (opts.views) page.videos[0].view_count = opts.views;
      return ok(page);
    }
  });
  return { service, calls };
}
const store = () => new History(new FakeD1(undefined, 'tiktok'));

test('collect stores account and recent videos, stops at the lookback cutoff', async () => {
  const s0 = store(); const { service, calls } = fake();
  const s = await collect(s0, service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'completed'); assert.equal(s.videos, 3); assert.equal(s.discovery_complete, true); assert.equal(s.pages, 2);
  assert.deepEqual(calls, ['user/info/', 'video/list/', 'video/list/']);
  const obs = await s0.runSnapshots(s.run_id);
  assert.equal(obs.find(o => o.target === 'account' && o.name === 'follower_count')!.value, 9);
  assert.equal(obs.find(o => o.target === 'v3' && o.name === 'share_count')!.value, 12);
  assert.ok(!(await s0.videos()).some(v => v.id === 'old'), 'posts before the cutoff are not stored');
  assert.equal((await s0.videos())[0].published_at, '2026-10-15T10:00:00.000Z');
});
test('page cap is reported as incomplete discovery', async () => {
  const s = await collect(store(), fake().service, { days: 365, pages: 1 }, AT);
  assert.equal(s.status, 'completed'); assert.equal(s.discovery_complete, false); assert.equal(s.videos, 2);
});
test('listing failure keeps account numbers, marks partial, never stores the token', async () => {
  const s0 = store();
  const s = await collect(s0, fake({ failList: 'rate_limit_exceeded' }).service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'partial'); assert.equal(s.stop_reason, 'quota_exceeded');
  assert.equal((await s0.runSnapshots(s.run_id)).length, 4);
  assert.ok(!JSON.stringify(s).includes(secret));
  assert.ok(!readFileSync((s0.db as FakeD1).path).toString('latin1').includes(secret));
});
test('a different account stops collection', async () => {
  const s = await collect(store(), fake({ openId: 'OTHER' }).service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'failed'); assert.equal(s.stop_reason, 'account_mismatch');
});
test('weekly digest gives week-over-week change only with a run 5+ days earlier', async () => {
  const db = new FakeD1(undefined, 'tiktok'); const s0 = new History(db);
  await collect(s0, fake({ followers: 9, views: 400 }).service, { days: 60, pages: 5 }, new Date('2026-10-11T05:00:00Z'));
  let d = await tiktokDigest(db, new Date('2026-10-11T06:00:00Z'));
  assert.equal(d.available, true); assert.equal(d.account.change_since_week_ago, null);
  await collect(s0, fake({ followers: 14, views: 900 }).service, { days: 60, pages: 5 }, AT);
  d = await tiktokDigest(db, AT);
  assert.equal(d.account.latest.follower_count, 14);
  assert.equal(d.account.change_since_week_ago.follower_count, 5);
  assert.equal(d.videos[0].id, 'v3'); assert.equal(d.videos[0].change_since_week_ago.view_count, 500);
  assert.equal(d.videos[0].title_start, 'deleted chat');
  assert.deepEqual(d.problems, []);
});
test('missing history is reported, not zero', async () => {
  const d = await tiktokDigest(new FakeD1(), AT);
  assert.equal(d.available, false);
});
test('status maps TikTok error codes', () => {
  const r = (http_status: number | null, code: string) => ({ retrieved_at: '', endpoint: '', http_status, body: { error: { code } } });
  assert.equal(status(r(200, 'ok')), 'available');
  assert.equal(status(r(401, 'access_token_invalid')), 'authentication_failed');
  assert.equal(status(r(429, 'rate_limit_exceeded')), 'quota_exceeded');
  assert.equal(status(r(200, 'scope_not_authorized')), 'permission_denied');
  assert.equal(status(r(null, '')), 'network_error');
});
test('redact keeps TikTok error.code so a successful answer still reads as available', () => {
  const body = redact({ data: { user: { open_id: 'x' } }, error: { code: 'ok', message: '', log_id: 'L' }, refresh_token: 'r' }, ['tok']);
  assert.equal(body.error.code, 'ok');
  assert.equal(body.refresh_token, '[REDACTED]');
  assert.equal(status({ retrieved_at: '', endpoint: 'user/info/', http_status: 200, body }), 'available');
});
test('a rotated refresh token is saved to D1 before use and wins over the older secret', async () => {
  const db = new FakeD1(undefined, 'tiktok');
  const secretCred = JSON.stringify({ refresh_token: 'old', open_id: 'OPEN1', saved_at: '2026-11-02T10:00:00Z' });
  const deps = { oauthClient: async () => ({ client_key: 'k', client_secret: 's' }), credentials: credentials(db, secretCred), saveCredential: saveCredential(db),
    postToken: async () => ({ http_status: 200, body: { access_token: 'a1', expires_in: 86400, refresh_token: 'new', refresh_expires_in: 31536000 } }) };
  assert.equal(await tokenSource(deps)(), 'a1');
  const now = await credentials(db, secretCred)();
  assert.equal(now.refresh_token, 'new'); assert.equal(now.open_id, 'OPEN1'); assert.ok(now.refresh_expires_at);
  // A new sign-in on your computer (newer saved_at) copied up again takes over from the stored one.
  const fresh = JSON.stringify({ refresh_token: 'fresh', open_id: 'OPEN1', saved_at: new Date(Date.now() + 60000).toISOString() });
  assert.equal((await credentials(db, fresh)()).refresh_token, 'fresh');
  const revoked = { ...deps, postToken: async () => ({ http_status: 400, body: { error: 'invalid_grant' } }) };
  await assert.rejects(tokenSource(revoked)(), (e: any) => e.code === 'authentication_failed');
});
