// Turns LinkedIn's creator analytics download (Analytics → Post impressions → Export, an .xlsx named
// AggregateAnalytics_<name>_<start>_<end>.xlsx) into dated values. Sheets as of November 2026:
//   DISCOVERY              "Overall Performance" + date range; Impressions, Members reached (totals for the range)
//   ENGAGEMENT             Date, Impressions, Engagements (one row per day)
//   MOST RECENT POSTS      Post URL, Publish Date, type, impressions (+ in/out-of-network %), members reached,
//                          followers gained, profile viewers, reactions, comments, reposts, saves, sends, button clicks
//   TOP POSTS              two lists side by side, up to 50 each: by Engagements and by Impressions
//   FOLLOWERS              "Total followers on <date>", then Date, New followers (one row per day)
//   AUDIENCE / CONTENT DEMOGRAPHICS  top companies, locations, titles… as rounded percentages (not imported)
// Every per-post number is a total within the file's date range, not lifetime: a 2022 post shows only its
// impressions inside the range. Dates are month/day/year. Cells are text; "-" or blank is missing, never 0.
import { readTables, toNumber, toDate, norm } from '../../shared/sheet.ts';
import type { Table, Cell } from '../../shared/sheet.ts';
import type { Parsed, Value, Item } from '../../shared/export-store.ts';

export class LinkedInExportError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

const recentColumns: Record<string, { name: string; unit: string }> = {
  'impressions': { name: 'impressions', unit: 'count' },
  'impressions (in-network)': { name: 'impressions_in_network_share', unit: 'percent' },
  'impressions (out-of-network)': { name: 'impressions_out_of_network_share', unit: 'percent' },
  'members reached': { name: 'members_reached', unit: 'count' },
  'followers gained': { name: 'followers_gained', unit: 'count' },
  'profile viewers': { name: 'profile_viewers', unit: 'count' },
  'reactions': { name: 'reactions', unit: 'count' },
  'comments': { name: 'comments', unit: 'count' },
  'reposts': { name: 'reposts', unit: 'count' },
  'saves': { name: 'saves', unit: 'count' },
  'sends': { name: 'sends', unit: 'count' },
  'custom button engagements': { name: 'custom_button_engagements', unit: 'count' },
  'engagements': { name: 'engagements', unit: 'count' }
};

// urn-like ID from the post URL (…-share-7523…-EFz2, …-ugcPost-7516…, /feed/update/urn:li:activity:…).
export function postId(url: string): string | null {
  const m = url.match(/(?:[-_:]|urn:li:)(share|ugcPost|activity)[-:](\d{15,22})/i);
  return m ? `linkedin:${m[1]}:${m[2]}` : null;
}
// The URL slug starts with the post's first words; good enough as a short label (untrusted text).
export function slugTitle(url: string): string | null {
  const m = url.match(/\/posts\/[^_/]+_([^/?#]+)/);
  if (!m) return null;
  let slug = m[1].replace(/(?:^|-)(share|ugcPost|activity)-\d{15,22}(-[A-Za-z0-9_]{2,6})?$/i, '');
  try { slug = decodeURIComponent(slug); } catch { /* keep the raw slug */ }
  const words = slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.slice(0, 80) : null;
}
const cleanUrl = (u: string) => u.trim().split('?')[0];
const sheet = (tables: Table[], name: string) => tables.find(t => norm(t.sheet) === name);
const headerRow = (rows: Cell[][], first: string) => rows.findIndex(r => norm(r[0]) === first);

export function parseTables(tables: Table[], fileName = ''): Parsed {
  const notes: string[] = [];
  const values: Value[] = [];
  const items = new Map<string, Item>();
  if (!sheet(tables, 'engagement') && !sheet(tables, 'followers') && !sheet(tables, 'discovery'))
    throw new LinkedInExportError('not_linkedin_export', 'This file does not look like a LinkedIn analytics export (no DISCOVERY, ENGAGEMENT or FOLLOWERS sheet).');

  // Date range: DISCOVERY's "11/14/2025 - 11/13/2026", else the file name, else the daily rows.
  let range_start: string | null = null, range_end: string | null = null;
  const disc = sheet(tables, 'discovery');
  const rangeText = String(disc?.rows.find(r => norm(r[0]) === 'overall performance')?.[1] ?? '');
  const rm = rangeText.match(/(.+?)\s*[-–]\s*(.+)/);
  if (rm) { range_start = toDate(rm[1]); range_end = toDate(rm[2]); }
  if (!range_start || !range_end) {
    const fm = fileName.match(/_(\d{4}-\d\d-\d\d)_(\d{4}-\d\d-\d\d)\.xlsx$/i);
    if (fm) { range_start = fm[1]; range_end = fm[2]; }
  }

  const add = (target: string, name: string, kind: Value['kind'], period_start: string | null, period_end: string | null, unit: string, value: number | null) => {
    if (period_end) values.push({ target, name, kind, period_start, period_end, unit, value });
  };

  // DISCOVERY totals for the whole range.
  if (disc) for (const r of disc.rows) {
    const label = norm(r[0]);
    if (label === 'impressions') add('account', 'impressions', 'range', range_start, range_end, 'count', toNumber(r[1]));
    if (label === 'members reached') add('account', 'members_reached', 'range', range_start, range_end, 'count', toNumber(r[1]));
  } else notes.push('No DISCOVERY sheet: range totals (impressions, members reached) not in this file.');

  // ENGAGEMENT: daily impressions and engagements.
  const eng = sheet(tables, 'engagement');
  let days: string[] = [];
  if (eng) {
    const h = headerRow(eng.rows, 'date');
    const cols = (eng.rows[h] ?? []).map(norm);
    const ci = cols.indexOf('impressions'), ce = cols.indexOf('engagements');
    for (const r of eng.rows.slice(h + 1)) {
      const d = toDate(r[0]);
      if (!d) continue;
      days.push(d);
      if (ci >= 0) add('account', 'impressions', 'day', d, d, 'count', toNumber(r[ci]));
      if (ce >= 0) add('account', 'engagements', 'day', d, d, 'count', toNumber(r[ce]));
    }
  } else notes.push('No ENGAGEMENT sheet: daily impressions and engagements not in this file.');

  // FOLLOWERS: total on the export date + new followers per day.
  const fol = sheet(tables, 'followers');
  if (fol) {
    for (const r of fol.rows) {
      const m = String(r[0] ?? '').trim().match(/^total followers on (.+)$/i);
      if (m) add('account', 'followers_total', 'point', null, toDate(m[1]) ?? range_end, 'count', toNumber(r[1]));
    }
    const h = headerRow(fol.rows, 'date');
    if (h >= 0) for (const r of fol.rows.slice(h + 1)) {
      const d = toDate(r[0]);
      if (d) { add('account', 'new_followers', 'day', d, d, 'count', toNumber(r[1])); days.push(d); }
    }
  } else notes.push('No FOLLOWERS sheet: follower numbers not in this file.');

  if ((!range_start || !range_end) && days.length) { days = days.sort(); range_start = days[0]; range_end = days[days.length - 1]; }
  if (!range_start || !range_end) throw new LinkedInExportError('no_date_range', 'Could not find the date range of this LinkedIn export.');
  // Range-kind values need the range; fill it in if it was found only after them.
  for (const v of values) if (v.kind === 'range') { v.period_start = range_start; v.period_end = range_end; }

  const item = (url: string, published: Cell, type?: Cell) => {
    const u = cleanUrl(url);
    const id = postId(u) ?? `linkedin:url:${u}`;
    const prev = items.get(id);
    items.set(id, { id, type: 'post', url: u, published_at: toDate(published) ?? prev?.published_at ?? null, title_start: slugTitle(u),
      metadata: { ...(prev?.metadata ?? {}), ...(type ? { post_type: String(type) } : {}) } });
    return id;
  };

  // MOST RECENT POSTS: the richest per-post numbers (totals within the range).
  const recent = sheet(tables, 'most recent posts');
  if (recent) {
    const h = headerRow(recent.rows, 'post url');
    const cols = (recent.rows[h] ?? []).map(norm);
    const pub = cols.indexOf('post publish date'), type = cols.indexOf('post type');
    for (const r of recent.rows.slice(h + 1)) {
      if (typeof r[0] !== 'string' || !/^https?:\/\//.test(r[0])) continue;
      const id = item(r[0], r[pub], type >= 0 ? r[type] : null);
      items.get(id)!.metadata!.most_recent = true;
      cols.forEach((c, i) => { const spec = recentColumns[c]; if (spec) add(id, spec.name, 'range', range_start, range_end, spec.unit, toNumber(r[i])); });
    }
  } else notes.push('No MOST RECENT POSTS sheet.');

  // TOP POSTS: two side-by-side lists (by engagements, by impressions). Only posts in the top 50 appear.
  const top = sheet(tables, 'top posts');
  if (top) {
    const h = headerRow(top.rows, 'post url');
    const header = (top.rows[h] ?? []).map(norm);
    const blocks = header.map((c, i) => c === 'post url' ? i : -1).filter(i => i >= 0);
    for (const start of blocks) {
      const metric = header[start + 2];
      const spec = recentColumns[metric];
      if (!spec) { notes.push(`TOP POSTS column "${metric}" not recognised, skipped.`); continue; }
      let rank = 0;
      for (const r of top.rows.slice(h + 1)) {
        const url = r[start];
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) continue;
        const id = item(url, r[start + 1]);
        rank++;
        const seen = values.some(v => v.target === id && v.name === spec.name);
        if (!seen) add(id, spec.name, 'range', range_start, range_end, spec.unit, toNumber(r[start + 2]));
        add(id, `top_rank_by_${spec.name}`, 'range', range_start, range_end, 'rank', rank);
      }
    }
  }
  notes.push('Audience and content demographics (rounded percentages) are not imported.');
  return { platform: 'linkedin', file_kind: 'linkedin_aggregate_analytics', range_start, range_end, items: [...items.values()], values, notes };
}

export const parseFile = (path: string) => parseTables(readTables(path), path.split('/').pop() ?? '');
