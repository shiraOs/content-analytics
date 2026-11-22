// Mirrors youtube/test/{collect,core}.test.ts against the D1 port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collect } from '../src/youtube/collect.ts';
import { History, compare } from '../src/youtube/history.ts';
import { status, rows, seconds, redact, tokenSource } from '../src/youtube/core.ts';
import { windows } from '../src/youtube/service.ts';
import { youtubeDigest } from '../src/weekly.ts';
import { fixture, secret } from './youtube-fixture.ts';
import { FakeD1 } from './d1.ts';

const store = () => new History(new FakeD1(undefined, 'youtube'));
const get = (obs: any[], target: string, window: string, name: string) => obs.find(o => o.target === target && o.window === window && o.name === name);

test('collect stores public, per-video, channel and traffic numbers with Shorts split', async () => {
  const s0 = store(); const { service, calls } = fixture();
  const s = await collect(s0, service);
  assert.equal(s.status, 'completed'); assert.equal(s.videos, 3); assert.equal(s.discovery_complete, true);
  const obs = await s0.runSnapshots(s.run_id);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'lifetime', 'views').value, 50);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'last_7_days', 'subscribersGained').value, 2);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'lifetime', 'averageViewDuration').unit, 'seconds');
  assert.equal(get(obs, 'CCCCCCCCCCC', 'lifetime', 'views').status, 'missing', 'brand-new video is missing, not zero');
  assert.equal(get(obs, 'channel', 'public', 'subscriberCount').value, 120);
  assert.equal(get(obs, 'channel:shorts', 'last_7_days', 'views').value, 30);
  assert.equal(get(obs, 'AAAAAAAAAAA:traffic:YT_SEARCH', 'lifetime', 'views').value, 30);
  const vids = await s0.videos();
  assert.equal(vids.find(v => v.id === 'BBBBBBBBBBB')!.content_type, 'SHORTS');
  assert.equal(vids.find(v => v.id === 'AAAAAAAAAAA')!.content_type, 'VIDEO_ON_DEMAND');
  assert.equal(vids.find(v => v.id === 'CCCCCCCCCCC')!.type_source, 'duration_guess');
  assert.ok(calls.some(c => c.params.filters === 'creatorContentType==shorts'), 'Shorts filter value is lowercase');
  assert.ok(calls.length + 1 <= 50, 'one collection fits the free-plan call limit');
  assert.ok(!readFileSync((s0.db as FakeD1).path).toString('latin1').includes(secret));
});
test('Shorts filter rejected falls back to duration guess', async () => {
  const s0 = store(); const s = await collect(s0, fixture('nofilter').service);
  assert.equal(s.status, 'completed');
  assert.ok((await s0.videos()).every(v => v.type_source === 'duration_guess'));
  assert.equal((await s0.videos()).find(v => v.id === 'BBBBBBBBBBB')!.content_type, 'SHORTS');
});
test('quota stops further analytics calls but keeps public stats', async () => {
  const s0 = store(); const { service, calls } = fixture('quota');
  const s = await collect(s0, service);
  assert.equal(s.status, 'partial'); assert.equal(s.stop_reason, 'quota_exceeded');
  assert.equal(calls.filter(c => c.endpoint === 'reports').length, 1);
  assert.ok(get(await s0.runSnapshots(s.run_id), 'AAAAAAAAAAA', 'public', 'viewCount'));
});
test('wrong channel, revoked sign-in and 401 fail the run without numbers', async () => {
  for (const [mode, code] of [['mismatch', 'account_mismatch'], ['revoked', 'authentication_failed'], ['auth', 'authentication_failed'], ['absent', 'not_configured']]) {
    const s = await collect(store(), fixture(mode).service);
    assert.equal(s.status, 'failed', mode); assert.equal(s.error.code, code, mode);
    assert.ok(!JSON.stringify(s).includes(secret));
  }
});
test('weekly digest reports week-over-week change and problems', async () => {
  const db = new FakeD1(undefined, 'youtube'); const s0 = new History(db);
  const { service } = fixture();
  await collect(s0, service, new Date(Date.now() - 7 * 86400000));
  await collect(s0, service);
  const d = await youtubeDigest(db);
  assert.equal(d.available, true); assert.ok(d.previous_run);
  const a = d.videos.find((v: any) => v.id === 'AAAAAAAAAAA');
  assert.equal(a.lifetime.views, 50); assert.ok(a.change_since_previous); assert.equal(typeof a.change_since_previous.views, 'number');
  assert.equal(d.top_by_subscribers_last_7_days[0].id, 'AAAAAAAAAAA');
  assert.deepEqual(d.problems, []);
  assert.equal((await youtubeDigest(new FakeD1())).available, false, 'no tables = no history, not zero');
});

const r = (http_status: number | null, body: any) => ({ retrieved_at: '', endpoint: '', parameters: {}, http_status, body });
test('status separates auth, quota, permission, bad request and network failures', () => {
  assert.equal(status(r(200, {})), 'available');
  assert.equal(status(r(401, { error: {} })), 'authentication_failed');
  assert.equal(status(r(403, { error: { errors: [{ reason: 'quotaExceeded' }] } })), 'quota_exceeded');
  assert.equal(status(r(429, { error: {} })), 'quota_exceeded');
  assert.equal(status(r(403, { error: { errors: [{ reason: 'forbidden' }] } })), 'permission_denied');
  assert.equal(status(r(400, { error: {} })), 'bad_request');
  assert.equal(status(r(null, { error: {} })), 'network_error');
});
test('analytics rows map by header; ISO durations parse', () => {
  assert.deepEqual(rows({ columnHeaders: [{ name: 'video' }, { name: 'views' }], rows: [['x', 3]] }), [{ video: 'x', views: 3 }]);
  assert.equal(seconds('PT9M30S'), 570); assert.equal(seconds('P0D'), 0); assert.equal(seconds('bad'), null);
});
test('redact removes tokens by key, value and query string', () => {
  const out = JSON.stringify(redact({ refresh_token: 'r1', note: 'x tok123 y', url: 'https://a/?access_token=zzz' }, ['tok123']));
  assert.ok(!out.includes('r1') && !out.includes('tok123') && !out.includes('zzz'));
});
test('token source gets a fresh access token per run, caches it, and reports a revoked sign-in', async () => {
  let posts = 0;
  const deps = { oauthClient: async () => ({ client_id: 'c', client_secret: 's' }), credentials: async () => ({ refresh_token: 'r' }),
    postToken: async () => { posts++; return { http_status: 200, body: { access_token: 'a', expires_in: 3600 } }; } };
  const t = tokenSource(deps); assert.equal(await t(), 'a'); assert.equal(await t(), 'a'); assert.equal(posts, 1);
  const bad = tokenSource({ ...deps, postToken: async () => ({ http_status: 400, body: { error: 'invalid_grant' } }) });
  await assert.rejects(bad(), (e: any) => e.code === 'authentication_failed');
});
test('windows and compare match the local collector', () => {
  const [l, w] = windows('2026-01-05T10:00:00Z', new Date('2026-10-16T12:00:00Z'));
  assert.deepEqual([l.start, l.end, w.start, w.end], ['2026-01-05', '2026-10-16', '2026-10-10', '2026-10-16']);
  const base = { channel_id: 'c', target: 'v', name: 'views', unit: 'count', window: 'lifetime', source: 'analytics', start_date: '2026-01-05', status: 'available' };
  const a = { ...base, retrieved_at: '2026-10-09T05:00:00Z', value: 100 }, b = { ...base, retrieved_at: '2026-10-16T05:00:00Z', value: 130 };
  assert.equal(compare(a, b).delta, 30);
  assert.equal(compare({ ...a, name: 'averageViewDuration' }, { ...b, name: 'averageViewDuration' }).delta, null);
  assert.equal(compare({ ...a, window: 'last_7_days' }, { ...b, window: 'last_7_days' }).delta, null);
});
