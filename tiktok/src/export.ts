// TikTok Studio analytics downloads (tiktok.com/tiktokstudio → Analytics → each tab → Download data).
// What each file holds, as of November 2026 (all account-wide unless stated):
//   Overview.xlsx           Date, Video Views, Profile Views, Likes, Comments, Shares          one row per day
//   Viewers.xlsx            Date, Total Viewers, New Viewers, Returning Viewers                one row per day
//   FollowerHistory.xlsx    Date, Followers, Difference in followers from previous day         one row per day
//   Content.xlsx            Time (download day), Video title, Video link, Post time, Total likes/comments/shares/views
//                           per video, lifetime, including videos older than the API's 60 days
//   FollowerActivity / FollowerGender / FollowerTopTerritories  audience breakdowns (empty below ~100 followers; not imported)
// Not in any download: watch time, retention, traffic sources or follows per video.
// Dates have no year ("November 12"); the year comes from the download time and the run of consecutive days.
// "undefined", "-" or blank cells are missing, never 0.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { readTables, toNumber, norm, resolveConsecutive, monthDay, latestOnOrBefore } from '../../shared/sheet.ts';
import type { Table, Cell } from '../../shared/sheet.ts';
import type { Parsed, Value, Item } from '../../shared/export-store.ts';

export class TikTokExportError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const daily: Record<string, { kind: string; columns: Record<string, { name: string; kind: 'day' | 'point' }> }> = {
  'date|video views|profile views|likes|comments|shares': { kind: 'tiktok_studio_overview', columns: {
    'video views': { name: 'video_views', kind: 'day' }, 'profile views': { name: 'profile_views', kind: 'day' },
    'likes': { name: 'likes', kind: 'day' }, 'comments': { name: 'comments', kind: 'day' }, 'shares': { name: 'shares', kind: 'day' } } },
  'date|total viewers|new viewers|returning viewers': { kind: 'tiktok_studio_viewers', columns: {
    'total viewers': { name: 'total_viewers', kind: 'day' }, 'new viewers': { name: 'new_viewers', kind: 'day' },
    'returning viewers': { name: 'returning_viewers', kind: 'day' } } },
  'date|followers|difference in followers from previous day': { kind: 'tiktok_studio_follower_history', columns: {
    'followers': { name: 'followers_total', kind: 'point' }, 'difference in followers from previous day': { name: 'followers_net_change', kind: 'day' } } }
};
const contentHeader = 'time|video title|video link|post time|total likes|total comments|total shares|total views';
const contentColumns: Record<string, string> = { 'total views': 'views', 'total likes': 'likes', 'total comments': 'comments', 'total shares': 'shares' };
const emptyBreakdowns = new Set(['date|hour|active followers', 'gender|distribution', 'top territories|distribution']);

// A TikTok video ID starts with its creation time: the top 32 bits are Unix seconds.
export function idTime(id: string): string | null {
  if (!/^\d{18,20}$/.test(id)) return null;
  const secs = Number(BigInt(id) >> 32n);
  return secs > 1.4e9 && secs < 4e9 ? new Date(secs * 1000).toISOString() : null;
}

export function parseTable(t: Table, downloadedAt: Date): Parsed | { skipped: string } {
  const h = t.rows.findIndex(r => r.some(c => c !== null && c !== ''));
  const header = (t.rows[h] ?? []).map(norm).filter(Boolean).join('|');
  const values: Value[] = [];
  const notes: string[] = [];
  const rows = t.rows.slice(h + 1).filter(r => r.some(c => c !== null && c !== ''));
  if (emptyBreakdowns.has(header)) return { skipped: `${t.file}: audience breakdown${rows.length ? '' : ' (empty)'}, not imported.` };

  const spec = daily[header];
  if (spec) {
    const cols = (t.rows[h] ?? []).map(norm);
    const dates = resolveConsecutive(rows.map(r => r[0]), downloadedAt);
    if (!dates) throw new TikTokExportError('dates_unclear', `${t.file}: the days are not consecutive or the year can't be worked out from the download time.`);
    if (!dates.length) return { skipped: `${t.file}: no rows.` };
    rows.forEach((r, i) => cols.forEach((c, ci) => {
      const col = spec.columns[c];
      if (col) values.push({ target: 'account', name: col.name, kind: col.kind, period_start: col.kind === 'day' ? dates[i] : null, period_end: dates[i], unit: 'count', value: toNumber(r[ci]) });
    }));
    const end = dates[dates.length - 1];
    if (downloadedAt.getTime() - Date.parse(end) > 14 * 86400000) notes.push(`${t.file}: newest day ${end} is more than two weeks before the download.`);
    return { platform: 'tiktok', file_kind: spec.kind, range_start: dates[0], range_end: end, items: [], values, notes };
  }

  if (header === contentHeader) {
    const cols = (t.rows[h] ?? []).map(norm);
    const at = (r: Cell[], name: string) => r[cols.indexOf(name)];
    const items: Item[] = [];
    let asOf: string | null = null;
    for (const r of rows) {
      const link = String(at(r, 'video link') ?? '');
      const id = link.match(/\/video\/(\d{15,22})/)?.[1];
      if (!id) { notes.push(`${t.file}: a row without a video link was skipped.`); continue; }
      const md = monthDay(at(r, 'time'));
      const day = md && latestOnOrBefore(md, downloadedAt);
      if (!day) throw new TikTokExportError('dates_unclear', `${t.file}: can't tell which day the totals are from.`);
      if (!asOf || day > asOf) asOf = day;
      const created = idTime(id);
      const title = at(r, 'video title');
      let url: string | null = null;
      try { const u = new URL(link); if (u.protocol === 'https:' && /(^|\.)tiktok\.com$/.test(u.hostname)) url = u.origin + u.pathname; } catch {}
      items.push({ id, type: 'video', url,
        published_at: created ? created.slice(0, 10) : null,
        title_start: typeof title === 'string' && title.trim() ? title.trim().slice(0, 80) : null,
        metadata: { post_time_label: at(r, 'post time') ?? null, link_as_given: link } });
      for (const [c, name] of Object.entries(contentColumns)) values.push({ target: id, name, kind: 'point', period_start: null, period_end: day, unit: 'count', value: toNumber(at(r, c)) });
    }
    return { platform: 'tiktok', file_kind: 'tiktok_studio_content', range_start: asOf, range_end: asOf, items, values, notes };
  }
  throw new TikTokExportError('unknown_sheet', `${t.file}: not a TikTok Studio analytics sheet I know (columns: ${header.slice(0, 120)}).`);
}

// One file → one Parsed (TikTok Studio files hold one sheet each). The download time is the file's
// modification time unless given; the importer refuses files older than 30 days for that reason.
export function parseFile(path: string, downloadedAt = statSync(path).mtime): Parsed | { skipped: string } {
  const tables = readTables(path);
  if (tables.length !== 1) throw new TikTokExportError('unexpected_layout', `${basename(path)}: expected one sheet, found ${tables.length}.`);
  return parseTable(tables[0], downloadedAt);
}
