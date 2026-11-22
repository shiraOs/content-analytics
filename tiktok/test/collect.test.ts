import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { collect } from '../src/collect.ts';
import { History, writerLock } from '../src/history.ts';
import { createTikTokService } from '../src/service.ts';
import { challenge, status, tokenSource } from '../src/core.ts';
import { tiktokDigest } from '../../youtube/src/weekly.ts';

const secret = 'act.SECRET-ACCESS-TOKEN';
const tmp = () => mkdtempSync(tmpdir() + '/tt-') + '/history.sqlite';
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

test('collect stores account and recent videos, stops at the lookback cutoff', async () => {
  const path = tmp(); const store = new History(path);
  const { service, calls } = fake();
  const s = await collect(store, service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'completed'); assert.equal(s.videos, 3); assert.equal(s.discovery_complete, true); assert.equal(s.pages, 2);
  assert.deepEqual(calls, ['user/info/', 'video/list/', 'video/list/']);
  const obs = store.runSnapshots(s.run_id);
  assert.equal(obs.find(o => o.target === 'account' && o.name === 'follower_count')!.value, 9);
  assert.equal(obs.find(o => o.target === 'v3' && o.name === 'share_count')!.value, 12);
  assert.ok(!store.videos().some(v => v.id === 'old'), 'posts before the cutoff are not stored');
  assert.equal(store.videos()[0].published_at, '2026-10-15T10:00:00.000Z');
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
});

test('page cap is reported as incomplete discovery', async () => {
  const store = new History(tmp());
  const s = await collect(store, fake().service, { days: 365, pages: 1 }, AT);
  assert.equal(s.status, 'completed'); assert.equal(s.discovery_complete, false); assert.equal(s.videos, 2);
  store.close();
});

test('listing failure keeps account numbers, marks partial, never stores the token', async () => {
  const path = tmp(); const store = new History(path);
  const s = await collect(store, fake({ failList: 'rate_limit_exceeded' }).service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'partial'); assert.equal(s.stop_reason, 'quota_exceeded');
  assert.equal(store.runSnapshots(s.run_id).length, 4);
  assert.ok(!JSON.stringify(s).includes(secret));
  store.close();
  assert.ok(!readFileSync(path).toString('latin1').includes(secret));
});

test('a different account stops collection', async () => {
  const store = new History(tmp());
  const s = await collect(store, fake({ openId: 'OTHER' }).service, { days: 60, pages: 5 }, AT);
  assert.equal(s.status, 'failed'); assert.equal(s.stop_reason, 'account_mismatch');
  store.close();
});

test('weekly digest gives week-over-week change only with a run 5+ days earlier', async () => {
  const path = tmp(); const store = new History(path);
  await collect(store, fake({ followers: 9, views: 400 }).service, { days: 60, pages: 5 }, new Date('2026-10-11T05:00:00Z'));
  let d = tiktokDigest(path, new Date('2026-10-11T06:00:00Z'));
  assert.equal(d.available, true); assert.equal(d.account.change_since_week_ago, null);
  await collect(store, fake({ followers: 14, views: 900 }).service, { days: 60, pages: 5 }, AT);
  store.close();
  d = tiktokDigest(path, AT);
  assert.equal(d.account.latest.follower_count, 14);
  assert.equal(d.account.change_since_week_ago.follower_count, 5);
  assert.equal(d.videos[0].id, 'v3'); assert.equal(d.videos[0].change_since_week_ago.view_count, 500);
  assert.equal(d.videos[0].title_start, 'deleted chat');
  assert.deepEqual(d.problems, []);
});

test('missing history is reported, not zero', () => {
  const d = tiktokDigest('/nonexistent/history.sqlite', AT);
  assert.equal(d.available, false); assert.match(d.problems[0], /npm run auth/);
});

test('overlapping collectors are refused', () => {
  const path = tmp(); const release = writerLock(path);
  assert.throws(() => writerLock(path), /Another collection/);
  release();
});

test('PKCE challenge is hex SHA-256 as TikTok desktop requires', () => {
  assert.equal(challenge('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.match(challenge('x'.repeat(64)), /^[0-9a-f]{64}$/);
});

test('status maps TikTok error codes', () => {
  const r = (http_status: number | null, code: string) => ({ retrieved_at: '', endpoint: '', http_status, body: { error: { code } } });
  assert.equal(status(r(200, 'ok')), 'available');
  assert.equal(status(r(401, 'access_token_invalid')), 'authentication_failed');
  assert.equal(status(r(429, 'rate_limit_exceeded')), 'quota_exceeded');
  assert.equal(status(r(200, 'scope_not_authorized')), 'permission_denied');
  assert.equal(status(r(null, '')), 'network_error');
});

test('a rotated refresh token is saved before use; a revoked one asks for sign-in', async () => {
  const saved: any[] = [];
  const deps = { oauthClient: async () => ({ client_key: 'k', client_secret: 's' }), credentials: async () => ({ refresh_token: 'old', open_id: 'OPEN1' }),
    saveCredential: async (c: any) => { saved.push(c); },
    postToken: async () => ({ http_status: 200, body: { access_token: 'a1', expires_in: 86400, refresh_token: 'new', refresh_expires_in: 31536000 } }) };
  assert.equal(await tokenSource(deps)(), 'a1');
  assert.equal(saved[0].refresh_token, 'new'); assert.equal(saved[0].open_id, 'OPEN1'); assert.ok(saved[0].refresh_expires_at);
  const revoked = { ...deps, postToken: async () => ({ http_status: 400, body: { error: 'invalid_grant' } }) };
  await assert.rejects(tokenSource(revoked)(), (e: any) => e.code === 'authentication_failed');
});
