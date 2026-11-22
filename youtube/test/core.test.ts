import test from 'node:test';
import assert from 'node:assert/strict';
import { status, rows, seconds, redact, tokenSource } from '../src/core.ts';
import { compare } from '../src/history.ts';
import { windows } from '../src/service.ts';

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
  assert.deepEqual(rows({}), []);
  assert.equal(seconds('PT9M30S'), 570); assert.equal(seconds('PT1H'), 3600); assert.equal(seconds('P0D'), 0); assert.equal(seconds('bad'), null);
});
test('redact removes tokens by key, value and query string', () => {
  const out = JSON.stringify(redact({ refresh_token: 'r1', note: 'x tok123 y', url: 'https://a/?access_token=zzz' }, ['tok123']));
  assert.ok(!out.includes('r1') && !out.includes('tok123') && !out.includes('zzz'));
});
test('token source refreshes once, caches, and reports a revoked sign-in', async () => {
  let posts = 0;
  const deps = { oauthClient: async () => ({ client_id: 'c', client_secret: 's' }), credentials: async () => ({ refresh_token: 'r' }),
    postToken: async () => { posts++; return { http_status: 200, body: { access_token: 'a', expires_in: 3600 } }; } };
  const t = tokenSource(deps); assert.equal(await t(), 'a'); assert.equal(await t(), 'a'); assert.equal(posts, 1);
  const bad = tokenSource({ ...deps, postToken: async () => ({ http_status: 400, body: { error: 'invalid_grant' } }) });
  await assert.rejects(bad(), (e: any) => e.code === 'authentication_failed');
});
test('windows: lifetime from channel start, rolling 7 days', () => {
  const [l, w] = windows('2026-01-05T10:00:00Z', new Date('2026-10-16T12:00:00Z'));
  assert.deepEqual([l.start, l.end, w.start, w.end], ['2026-01-05', '2026-10-16', '2026-10-10', '2026-10-16']);
});
test('compare subtracts only matching cumulative counters', () => {
  const base = { channel_id: 'c', target: 'v', name: 'views', unit: 'count', window: 'lifetime', source: 'analytics', start_date: '2026-01-05', status: 'available' };
  const a = { ...base, retrieved_at: '2026-10-09T05:00:00Z', value: 100 }, b = { ...base, retrieved_at: '2026-10-16T05:00:00Z', value: 130 };
  assert.equal(compare(a, b).delta, 30);
  assert.equal(compare(b, a).delta, null);
  assert.equal(compare({ ...a, name: 'averageViewDuration' }, { ...b, name: 'averageViewDuration' }).delta, null);
  assert.equal(compare({ ...a, window: 'last_7_days' }, { ...b, window: 'last_7_days' }).delta, null);
  assert.equal(compare(a, { ...b, status: 'missing', value: null }).delta, null);
  assert.equal(compare(a, { ...b, value: 90 }).delta, -10);
});
