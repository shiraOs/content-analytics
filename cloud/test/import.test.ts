// The one-time import: a local history file replayed into D1 gives the same digest, and repeating it changes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dump, literal } from '../scripts/import-history.ts';
import { collect } from '../src/youtube/collect.ts';
import { History } from '../src/youtube/history.ts';
import { youtubeDigest } from '../src/weekly.ts';
import { fixture } from './youtube-fixture.ts';
import { FakeD1 } from './d1.ts';

test('import replays a history file into D1 idempotently, and later runs compare against it', async () => {
  const mac = new FakeD1(undefined, 'youtube');
  await collect(new History(mac), fixture().service, new Date(Date.now() - 7 * 86400000));
  const { sql, counts } = dump(mac.path, 'youtube');
  assert.equal(counts.collection_runs, 1); assert.ok(counts.snapshots > 50);
  const cloud = new FakeD1(undefined, 'youtube');
  cloud.db.exec(sql); cloud.db.exec(sql);
  assert.equal((cloud.db.prepare('SELECT count(*) AS n FROM snapshots').get() as any).n, counts.snapshots);
  await collect(new History(cloud), fixture().service);
  const d = await youtubeDigest(cloud);
  assert.ok(d.previous_run, 'the imported local run is the week-ago baseline');
  assert.equal(typeof d.videos.find((v: any) => v.id === 'AAAAAAAAAAA').change_since_previous.views, 'number');
});
test('SQL literals escape quotes and keep numbers and nulls', () => {
  assert.equal(literal("it's"), "'it''s'"); assert.equal(literal(3), '3'); assert.equal(literal(null), 'NULL');
});
