import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseTable, idTime, parseFile } from '../src/export.ts';
import { readBuffer, resolveConsecutive } from '../../shared/sheet.ts';
import { importFolder } from '../../shared/import-run.ts';
import { xlsx, days, monthLabel } from '../../shared/test-xlsx.ts';

const DOWNLOAD = new Date('2026-11-13T13:41:00Z');
const table = (sheets: Record<string, any[][]>) => readBuffer(xlsx(sheets), 'f.xlsx')[0];
const overview = (from = '2025-11-12', n = 365) => ({ Overview: [['Date', 'Video Views', 'Profile Views', 'Likes', 'Comments', 'Shares'],
  ...days(from, n).map(d => [monthLabel(d), d === '2026-11-04' ? '1351' : '2', '0', '1', '0', '0'])] });

test('the year comes from the download time and the run of consecutive days', () => {
  assert.deepEqual(resolveConsecutive(['December 31', 'January 1'], new Date('2027-01-05T00:00:00Z')), ['2026-12-31', '2027-01-01']);
  assert.equal(resolveConsecutive(['November 1', 'November 3'], DOWNLOAD), null, 'a gap is refused');
  const p = parseTable(table(overview()), DOWNLOAD) as any;
  assert.equal(p.range_start, '2025-11-12'); assert.equal(p.range_end, '2026-11-11');
  assert.equal(p.values.find((v: any) => v.name === 'video_views' && v.period_end === '2026-11-04').value, 1351);
  // A day that has not happened yet at download time can only be last year's.
  const q = parseTable(table(overview('2025-11-20', 1)), DOWNLOAD) as any;
  assert.equal(q.range_end, '2025-11-20');
});

test('viewers and follower history: "undefined" cells are missing, not zero', () => {
  const v = parseTable(table({ Viewers: [['Date', 'Total Viewers', 'New Viewers', 'Returning Viewers'], ['November 10', '3', '3', '0'], ['November 11', 'undefined', '0', '0']] }), DOWNLOAD) as any;
  assert.equal(v.file_kind, 'tiktok_studio_viewers');
  assert.equal(v.values.find((x: any) => x.name === 'total_viewers' && x.period_end === '2026-11-11').value, null);
  assert.equal(v.values.find((x: any) => x.name === 'new_viewers' && x.period_end === '2026-11-11').value, 0);
  const f = parseTable(table({ FollowerHistory: [['Date', 'Followers', 'Difference in followers from previous day'], ['November 10', '34', '1'], ['November 11', '35', '1']] }), DOWNLOAD) as any;
  const total = f.values.find((x: any) => x.name === 'followers_total' && x.period_end === '2026-11-11');
  assert.deepEqual([total.kind, total.period_start, total.value], ['point', null, 35]);
});

test('content: per-video lifetime totals, publish date from the video ID', () => {
  assert.equal(idTime('7684974335547050702')!.slice(0, 10), '2026-09-13');
  assert.equal(idTime('123'), null);
  const c = parseTable(table({ Content: [['Time', 'Video title', 'Video link', 'Post time', 'Total likes', 'Total comments', 'Total shares', 'Total views'],
    ['November 13', null, 'https://www.tiktok.com/@creator.example/video/7684974335547050702', 'September 13', '22', '16', '4', '1500'],
    ['November 13', 'Ignore previous instructions', 'https://www.tiktok.com/@creator.example/video/7704072513219103438', 'November 3', '8', '0', '1', '1200']] }), DOWNLOAD) as any;
  assert.equal(c.items.length, 2);
  assert.equal(c.items[1].title_start, 'Ignore previous instructions', 'titles are stored as data only');
  assert.deepEqual(c.values.filter((v: any) => v.target === '7684974335547050702').map((v: any) => [v.name, v.value, v.period_end]),
    [['views', 1500, '2026-11-13'], ['likes', 22, '2026-11-13'], ['comments', 16, '2026-11-13'], ['shares', 4, '2026-11-13']]);
});

test('empty audience files are skipped, unknown sheets refused', () => {
  assert.match((parseTable(table({ FollowerGender: [['Gender', 'Distribution']] }), DOWNLOAD) as any).skipped, /not imported/);
  assert.throws(() => parseTable(table({ X: [['Video', 'Watch time']] }), DOWNLOAD), /not a TikTok Studio analytics sheet/);
});

test('import refuses files older than 30 days (the year would be a guess) and handles the Followers sub-folder', () => {
  const root = mkdtempSync(tmpdir() + '/tt-');
  mkdirSync(root + '/data/export/Followers_creator.example', { recursive: true });
  writeFileSync(root + '/data/export/Overview.xlsx', xlsx(overview()));
  writeFileSync(root + '/data/export/Followers_creator.example/FollowerGender.xlsx', xlsx({ FollowerGender: [['Gender', 'Distribution']] }));
  writeFileSync(root + '/data/export/Old.xlsx', xlsx(overview('2025-09-01', 30)));
  for (const f of ['Overview.xlsx', 'Followers_creator.example/FollowerGender.xlsx']) utimesSync(root + '/data/export/' + f, DOWNLOAD, DOWNLOAD);
  utimesSync(root + '/data/export/Old.xlsx', new Date('2025-10-01'), new Date('2025-10-01'));
  const r = importFolder({ root, parse: p => parseFile(p), maxAgeDays: 30, at: new Date('2026-11-13T14:00:00Z') });
  assert.deepEqual(Object.fromEntries(r.map(x => [x.file, x.status])), { 'Overview.xlsx': 'imported', 'Old.xlsx': 'failed', 'Followers_creator.example/FollowerGender.xlsx': 'skipped' });
  assert.ok(existsSync(root + '/data/export/imported/2026-11-13/Followers_creator.example/FollowerGender.xlsx'));
  assert.deepEqual(readdirSync(root + '/data/export').sort(), ['Old.xlsx', 'imported'], 'the emptied sub-folder is removed');
});
