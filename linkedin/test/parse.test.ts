import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { parseTables, postId, slugTitle } from '../src/parse.ts';
import { readBuffer, readCsv, toNumber, toDate } from '../../shared/sheet.ts';
import { importFolder } from '../../shared/import-run.ts';
import { linkedinWorkbook, xlsx, zip } from '../../shared/test-xlsx.ts';
import { parseFile } from '../src/parse.ts';

const POST = 'https://www.linkedin.com/posts/creator_%D7%98%D7%A1%D7%AA%D7%99-share-7523020899558176121-AbCd';
const REPOST = 'https://www.linkedin.com/posts/creator_ugcPost-7516399505055495545-EfGh';
const OLD = 'https://www.linkedin.com/posts/creator_an-older-post-share-7500550772363441529-IjKl';
const book = (over: Partial<Parameters<typeof linkedinWorkbook>[0]> = {}) => linkedinWorkbook({ start: '2025-11-14', end: '2026-11-13',
  impressions: d => d === '2026-11-12' ? 22 : 1, followers: 1000,
  recent: [[POST, '11/2/2026', 'Image', '171', '75%', '25%', '106', '0', '0', '4', '0', '0', '-', '0', '0'], [REPOST, '10/15/2026', 'Repost', '26', '81%', '19%', '9', '0', '0', '0', '0', '0', '0', '0', '0']],
  top: [[OLD, '9/1/2026', '53', '', OLD, '9/1/2026', '700'], [POST, '11/2/2026', '4', '', '', '', '']], ...over });

test('reads the xlsx parts: shared strings, numbers, gaps between cells, compressed and stored', () => {
  for (const compress of [true, false]) {
    const t = readBuffer(zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="A &amp; B" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/s.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>x</t></si><si><r><t>ri</t></r><r><t xml:space="preserve">ch</t></r></si></sst>',
      'xl/worksheets/s.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>5</v></c></row><row r="3"><c r="B3" t="s"><v>1</v></c><c r="C3" t="inlineStr"><is><t>in</t></is></c></row></sheetData></worksheet>' }, compress), 'f.xlsx');
    assert.equal(t[0].sheet, 'A & B');
    assert.deepEqual(t[0].rows, [['x', null, 5], [], [null, 'rich', 'in']]);
  }
});

test('CSV, numbers and dates: blank or "-" is missing, never zero', () => {
  assert.deepEqual(readCsv('a,b\r\n"1,2",\n"x ""y""",-\n').rows, [['a', 'b'], ['1,2', null], ['x "y"', '-']]);
  assert.equal(toNumber('1,234'), 1234); assert.equal(toNumber('75%'), 75); assert.equal(toNumber('1.2K'), 1200);
  for (const v of ['', '-', 'undefined', '< 1%', null]) assert.equal(toNumber(v as any), null, String(v));
  assert.equal(toDate('11/2/2026'), '2026-11-02'); assert.equal(toDate('2/30/2026'), null); assert.equal(toDate(46000), '2025-12-09');
});

test('rejects files that are not exports, and broken archives', () => {
  assert.throws(() => readBuffer(Buffer.from('hello'), 'x.xlsx'), /not a ZIP/);
  assert.throws(() => readBuffer(Buffer.from('x'), 'x.pdf'), /Unsupported/);
  assert.throws(() => parseTables(readBuffer(xlsx({ Sheet1: [['a']] }), 'x.xlsx')), /does not look like a LinkedIn/);
});

test('post IDs and labels come from the link', () => {
  assert.equal(postId(POST), 'linkedin:share:7523020899558176121');
  assert.equal(postId(REPOST), 'linkedin:ugcPost:7516399505055495545');
  assert.equal(postId('https://www.linkedin.com/feed/update/urn:li:activity:7516399505055495545/'), 'linkedin:activity:7516399505055495545');
  assert.equal(slugTitle(POST), 'טסתי');
  assert.equal(slugTitle(REPOST), null, 'a repost link has no words');
  assert.equal(slugTitle(OLD), 'an older post');
});

test('parses a LinkedIn export into dated values with units', () => {
  const p = parseTables(readBuffer(book(), 'AggregateAnalytics_X_2025-11-14_2026-11-13.xlsx'));
  assert.equal(p.range_start, '2025-11-14'); assert.equal(p.range_end, '2026-11-13');
  const v = (target: string, name: string, end?: string) => p.values.find(x => x.target === target && x.name === name && (!end || x.period_end === end));
  assert.equal(v('account', 'impressions', '2026-11-12')!.value, 22);
  assert.equal(v('account', 'impressions', '2026-11-12')!.kind, 'day');
  assert.deepEqual({ ...v('account', 'followers_total')! }, { target: 'account', name: 'followers_total', kind: 'point', period_start: null, period_end: '2026-11-13', unit: 'count', value: 1000 });
  assert.equal(v('account', 'members_reached')!.kind, 'range');
  const id = 'linkedin:share:7523020899558176121';
  assert.equal(v(id, 'impressions')!.value, 171, 'MOST RECENT POSTS wins over the TOP POSTS duplicate');
  assert.equal(v(id, 'saves')!.value, null, '"-" is kept as missing');
  assert.equal(v(id, 'impressions_in_network_share')!.unit, 'percent');
  assert.equal(v('linkedin:share:7500550772363441529', 'impressions')!.value, 700);
  assert.equal(v('linkedin:share:7500550772363441529', 'top_rank_by_impressions')!.value, 1);
  assert.equal(p.items.find(i => i.id === id)!.published_at, '2026-11-02');
  assert.equal(p.items.find(i => i.id === id)!.metadata!.post_type, 'Image');
  assert.equal(p.values.filter(x => x.target === 'account' && x.name === 'impressions' && x.kind === 'day').length, 365);
});

test('import moves the file away, stores it once, and keeps failures in place', () => {
  const root = mkdtempSync(tmpdir() + '/li-');
  mkdirSync(root + '/data/export', { recursive: true });
  writeFileSync(root + '/data/export/AggregateAnalytics_X_2025-11-14_2026-11-13.xlsx', book());
  writeFileSync(root + '/data/export/notes.xlsx', xlsx({ Sheet1: [['hello']] }));
  const at = new Date('2026-11-13T12:00:00Z');
  const r = importFolder({ root, parse: parseFile, at });
  assert.deepEqual(r.map(x => x.status).sort(), ['failed', 'imported']);
  assert.ok(existsSync(root + '/data/export/imported/2026-11-13/AggregateAnalytics_X_2025-11-14_2026-11-13.xlsx'));
  assert.ok(existsSync(root + '/data/export/notes.xlsx'), 'a file that failed stays for the owner to see');
  // The same file again (same bytes) is recognised.
  writeFileSync(root + '/data/export/copy.xlsx', book());
  const again = importFolder({ root, parse: parseFile, at });
  assert.equal(again.find(x => x.file === 'copy.xlsx')!.status, 'duplicate');
  const db = new DatabaseSync(root + '/data/history.sqlite', { readOnly: true });
  assert.equal((db.prepare('SELECT COUNT(*) n FROM export_files').get() as any).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM export_values WHERE status='missing'").get() as any).n, 1);
  db.close();
  assert.deepEqual(readdirSync(root + '/data/export').sort(), ['imported', 'notes.xlsx']);
});
