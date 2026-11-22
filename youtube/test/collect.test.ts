import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { collect } from '../src/collect.ts';
import { History, writerLock } from '../src/history.ts';
import { youtubeDigest, instagramDigest } from '../src/weekly.ts';
import { fixture, secret } from './fixture.ts';

const tmp = () => mkdtempSync(tmpdir() + '/yt-') + '/history.sqlite';
const get = (obs: any[], target: string, window: string, name: string) => obs.find(o => o.target === target && o.window === window && o.name === name);

test('collect stores public, per-video, channel and traffic numbers with Shorts split', async () => {
  const path = tmp(); const store = new History(path);
  const { service } = fixture();
  const s = await collect(store, service);
  assert.equal(s.status, 'completed'); assert.equal(s.videos, 3); assert.equal(s.discovery_complete, true);
  const obs = store.runSnapshots(s.run_id);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'lifetime', 'views').value, 50);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'last_7_days', 'subscribersGained').value, 2);
  assert.equal(get(obs, 'AAAAAAAAAAA', 'lifetime', 'averageViewDuration').unit, 'seconds');
  assert.equal(get(obs, 'CCCCCCCCCCC', 'lifetime', 'views').status, 'missing', 'brand-new video is missing, not zero');
  assert.equal(get(obs, 'channel', 'public', 'subscriberCount').value, 120);
  assert.equal(get(obs, 'channel:shorts', 'last_7_days', 'views').value, 30);
  assert.equal(get(obs, 'AAAAAAAAAAA:traffic:YT_SEARCH', 'lifetime', 'views').value, 30);
  const vids = store.videos();
  assert.equal(vids.find(v => v.id === 'BBBBBBBBBBB')!.content_type, 'SHORTS');
  assert.equal(vids.find(v => v.id === 'AAAAAAAAAAA')!.content_type, 'VIDEO_ON_DEMAND');
  assert.equal(vids.find(v => v.id === 'CCCCCCCCCCC')!.type_source, 'duration_guess');
  assert.ok(!readFileSync(path).toString('latin1').includes(secret));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  store.close();
});
test('Shorts filter rejected falls back to duration guess', async () => {
  const store = new History(tmp()); const s = await collect(store, fixture('nofilter').service);
  assert.equal(s.status, 'completed');
  assert.ok(store.videos().every(v => v.type_source === 'duration_guess'));
  assert.equal(store.videos().find(v => v.id === 'BBBBBBBBBBB')!.content_type, 'SHORTS');
  store.close();
});
test('quota stops further analytics calls but keeps public stats', async () => {
  const store = new History(tmp()); const { service, calls } = fixture('quota');
  const s = await collect(store, service);
  assert.equal(s.status, 'partial'); assert.equal(s.stop_reason, 'quota_exceeded');
  assert.equal(calls.filter(c => c.endpoint === 'reports').length, 1);
  assert.ok(get(store.runSnapshots(s.run_id), 'AAAAAAAAAAA', 'public', 'viewCount'));
  store.close();
});
test('wrong channel, revoked sign-in and 401 fail the run without numbers', async () => {
  for (const [mode, code] of [['mismatch', 'account_mismatch'], ['revoked', 'authentication_failed'], ['auth', 'authentication_failed'], ['absent', 'not_configured']]) {
    const store = new History(tmp()); const s = await collect(store, fixture(mode).service);
    assert.equal(s.status, 'failed', mode); assert.equal(s.error.code, code, mode);
    assert.ok(!JSON.stringify(s).includes(secret)); store.close();
  }
});
test('writer lock excludes a second collector', () => {
  const path = tmp(); const release = writerLock(path);
  assert.throws(() => writerLock(path), (e: any) => e.code === 'collection_busy');
  release(); writerLock(path)();
});
test('weekly digest reports week-over-week change and problems', async () => {
  const path = tmp(); const store = new History(path);
  const { service } = fixture();
  await collect(store, service, undefined, new Date(Date.now() - 7 * 86400000));
  await collect(store, service);
  store.close();
  const d = youtubeDigest(path);
  assert.equal(d.available, true); assert.ok(d.previous_run);
  const a = d.videos.find((v: any) => v.id === 'AAAAAAAAAAA');
  assert.equal(a.lifetime.views, 50); assert.ok(a.change_since_previous); assert.equal(typeof a.change_since_previous.views, 'number');
  assert.equal(d.top_by_subscribers_last_7_days[0].id, 'AAAAAAAAAAA');
  assert.deepEqual(d.problems, []);
  assert.equal(youtubeDigest('/nonexistent/x.sqlite').available, false);
});
test('instagram digest reads the existing schema read-only', () => {
  const path = tmp(); const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE collection_runs (id TEXT, kind TEXT, started_at TEXT, finished_at TEXT, status TEXT, details_json TEXT);
    CREATE TABLE media (id TEXT, account_id TEXT, publication_time TEXT, metadata_json TEXT);
    CREATE TABLE metric_snapshots (id TEXT, account_id TEXT, media_id TEXT, retrieved_at TEXT, api_version TEXT, name TEXT, unit TEXT, period TEXT, meaning TEXT, status TEXT, value_json TEXT, details_json TEXT);`);
  const t = (d: number) => new Date(Date.now() - d * 86400000).toISOString();
  db.prepare('INSERT INTO collection_runs VALUES (?,?,?,?,?,?)').run('r', 'collection', t(0), t(0), 'completed', '{}');
  db.prepare('INSERT INTO media VALUES (?,?,?,?)').run('1', 'a', t(10), JSON.stringify({ media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/x/' }));
  for (const [d, v] of [[7, 100], [0, 160]]) db.prepare("INSERT INTO metric_snapshots VALUES (?,?,?,?,?,?,?,?,?,'available',?,?)").run('s' + d, 'a', '1', t(d), 'v25.0', 'views', 'count', 'lifetime', null, String(v), '{}');
  db.close();
  const d = instagramDigest(path);
  assert.equal(d.reels[0].latest.views, 160); assert.equal(d.reels[0].change_since_week_ago.views, 60); assert.deepEqual(d.problems, []);
});
