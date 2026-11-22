// Downloads imported on your computer → rows sent to D1 → the Sunday digest's LinkedIn group and TikTok `studio` part.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { FakeD1, fakeEnv } from './d1.ts';
import { dumpExports } from '../scripts/import-exports.ts';
import { linkedinDigest, tiktokStudio } from '../src/exports.ts';
import { digest } from '../src/weekly.ts';
import { schema } from '../../shared/export-store.ts';
import { importFolder } from '../../shared/import-run.ts';
import { linkedinWorkbook, xlsx, days, monthLabel } from '../../shared/test-xlsx.ts';
import { parseFile as parseLinkedIn } from '../../linkedin/src/parse.ts';
import { parseFile as parseTikTok } from '../../tiktok/src/export.ts';

const POST = 'https://www.linkedin.com/posts/creator_testing-share-7523020899558176121-AbCd';
const recent = (impressions: number) => [[POST, '11/2/2026', 'Image', String(impressions), '75%', '25%', '106', '1', '0', '4', '0', '0', '0', '0', '0']];
const root = () => { const r = mkdtempSync(tmpdir() + '/exp-'); mkdirSync(r + '/data/export', { recursive: true }); return r; };
const push = (local: string, d1: FakeD1) => {
  const known = new Set((d1.db.prepare('SELECT digest FROM export_files').all() as any[]).map(r => r.digest));
  const { sql, files } = dumpExports(local + '/data/history.sqlite', known);
  if (sql) d1.db.exec(sql);
  return files;
};

test('the cloud schemas match the local export tables', () => {
  const cols = (sql: string) => { const db = new DatabaseSync(':memory:'); db.exec(sql);
    return ['export_files', 'export_items', 'export_values'].map(t => db.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`).join()); };
  for (const s of ['linkedin', 'tiktok']) {
    const cloud = new FakeD1(undefined, s).db.prepare("SELECT group_concat(sql,';') AS s FROM sqlite_master WHERE name LIKE 'export_%'").get() as any;
    assert.deepEqual(cols(cloud.s), cols(schema), s);
  }
});

test('LinkedIn: this week, followers and post change from two weekly files', async () => {
  const mac = root(), d1 = new FakeD1(undefined, 'linkedin');
  // Week 1: downloaded Nov 6. Week 2: downloaded Nov 13, with one day revised and a gap on Nov 10.
  writeFileSync(mac + '/data/export/AggregateAnalytics_X_2025-11-07_2026-11-06.xlsx',
    linkedinWorkbook({ start: '2025-11-07', end: '2026-11-06', impressions: () => 2, newFollowers: () => '1', followers: 992, recent: recent(100) }));
  importFolder({ root: mac, parse: parseLinkedIn, at: new Date('2026-11-06T10:00:00Z') });
  assert.equal(push(mac, d1), 1);
  writeFileSync(mac + '/data/export/AggregateAnalytics_X_2025-11-14_2026-11-13.xlsx',
    linkedinWorkbook({ start: '2025-11-14', end: '2026-11-13', impressions: d => d === '2026-11-12' ? 22 : d === '2026-11-05' ? 9 : 2, newFollowers: () => '1', followers: 1000, recent: recent(171) }));
  importFolder({ root: mac, parse: parseLinkedIn, at: new Date('2026-11-13T10:00:00Z') });
  assert.equal(push(mac, d1), 1, 'only the new file is sent');
  assert.equal(push(mac, d1), 0, 'sending again changes nothing');

  const li = await linkedinDigest(d1, new Date('2026-11-15T07:00:00Z'));
  assert.equal(li.available, true);
  assert.deepEqual(li.problems, []);
  assert.deepEqual(li.account.followers, { value: 1000, on: '2026-11-13', change_since_previous: { value: 8, since: '2026-11-06' } });
  // Nov 6–12: six days of 2 and the 22 on Nov 12.
  assert.deepEqual(li.account.this_week, { from: '2026-11-06', to: '2026-11-12', impressions: 34, engagements: 7, new_followers: 7 });
  // Oct 30–Nov 5: the newer file's 9 for Nov 5 replaces the older file's 2.
  assert.equal(li.account.previous_week.impressions, 6 * 2 + 9);
  const post = li.recent_posts.find((p: any) => p.id === 'linkedin:share:7523020899558176121');
  assert.equal(post.in_range.impressions, 171);
  assert.equal(post.change_since_previous_file.impressions, 71);
  assert.equal(post.label, 'testing');
  // A week later with no new file, the report says so.
  const stale = await linkedinDigest(d1, new Date('2026-11-23T07:00:00Z'));
  assert.match(stale.problems[0], /newest LinkedIn file ends 2026-11-13/);
});

test('LinkedIn: a missing day gives no weekly sum, and no file at all is reported, not zero', async () => {
  const mac = root(), d1 = new FakeD1(undefined, 'linkedin');
  writeFileSync(mac + '/data/export/a.xlsx', linkedinWorkbook({ start: '2026-10-14', end: '2026-11-13', impressions: d => d === '2026-11-10' ? '-' : 1, followers: 5 }));
  importFolder({ root: mac, parse: parseLinkedIn, at: new Date('2026-11-13T10:00:00Z') });
  push(mac, d1);
  const li = await linkedinDigest(d1, new Date('2026-11-15T07:00:00Z'));
  assert.equal(li.account.this_week.impressions, null);
  assert.equal(li.account.this_week.impressions_days_with_data, 6);
  assert.equal(li.account.followers.change_since_previous, null);
  const none = await linkedinDigest(new FakeD1(undefined, 'linkedin'));
  assert.equal(none.available, false);
  assert.match(none.problems[0], /No LinkedIn analytics file imported yet/);
  assert.equal((await linkedinDigest(undefined)).available, false);
});

test('TikTok Studio: weekly sums per file, followers, all-video totals; old file is a note, not a problem', async () => {
  const mac = root(), env = fakeEnv();
  const dl = new Date('2026-11-13T13:41:00Z');
  const ds = days('2026-10-01', 42); // Oct 1 – Nov 11
  writeFileSync(mac + '/data/export/Overview.xlsx', xlsx({ Overview: [['Date', 'Video Views', 'Profile Views', 'Likes', 'Comments', 'Shares'], ...ds.map(d => [monthLabel(d), '10', '1', '2', '0', '0'])] }));
  writeFileSync(mac + '/data/export/Viewers.xlsx', xlsx({ Viewers: [['Date', 'Total Viewers', 'New Viewers', 'Returning Viewers'], ...[...ds, '2026-11-12'].map(d => [monthLabel(d), d === '2026-11-12' ? 'undefined' : '5', d === '2026-11-12' ? '0' : '4', '1'])] }));
  writeFileSync(mac + '/data/export/FollowerHistory.xlsx', xlsx({ FollowerHistory: [['Date', 'Followers', 'Difference in followers from previous day'], ...ds.map((d, i) => [monthLabel(d), String(20 + i), '1'])] }));
  writeFileSync(mac + '/data/export/Content.xlsx', xlsx({ Content: [['Time', 'Video title', 'Video link', 'Post time', 'Total likes', 'Total comments', 'Total shares', 'Total views'],
    ['November 13', null, 'https://www.tiktok.com/@creator.example/video/7684974335547050702', 'September 13', '22', '16', '4', '1500']] }));
  for (const f of ['Overview', 'Viewers', 'FollowerHistory', 'Content']) utimesSync(`${mac}/data/export/${f}.xlsx`, dl, dl);
  const r = importFolder({ root: mac, parse: p => parseTikTok(p), maxAgeDays: 30, at: dl });
  assert.ok(r.every(x => x.status === 'imported'), JSON.stringify(r));
  push(mac, env.TIKTOK_DB);

  const s = await tiktokStudio(env.TIKTOK_DB, new Date('2026-11-15T07:00:00Z'));
  assert.deepEqual(s.overview.this_week, { from: '2026-11-05', to: '2026-11-11', video_views: 70, profile_views: 7, likes: 14, comments: 0, shares: 0 });
  // Viewers' last day (Nov 12) has 0 new viewers but an empty total; the week still ends Nov 12 for new viewers.
  assert.equal(s.viewers.this_week.to, '2026-11-12');
  assert.deepEqual(s.followers, { value: 61, on: '2026-11-11', week_ago: { value: 54, on: '2026-11-04' }, net_change_this_week: 7 });
  assert.equal(s.all_videos_lifetime.videos[0].lifetime.views, 1500);
  const later = await tiktokStudio(env.TIKTOK_DB, new Date('2026-12-01T07:00:00Z'));
  assert.ok(later.notes.some((n: string) => /download again/.test(n)));

  // In the full digest: TikTok gets `studio`, LinkedIn its own section, the API part is untouched.
  const d = await digest(env, new Date('2026-11-15T07:00:00Z'));
  assert.equal(d.tiktok.studio.available, true);
  assert.equal(d.linkedin.available, false);
  assert.equal(d.tiktok.available, false, 'no API collection in this test');
});
