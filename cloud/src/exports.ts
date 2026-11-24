// Digest sections for numbers that come from files you download and imports on your computer (no API):
//   linkedinDigest   — LinkedIn creator analytics (D1 content-linkedin)
//   tiktokStudio     — TikTok Studio downloads, added to the TikTok section as `studio` (D1 content-tiktok)
// Tables: ../schema/linkedin.sql (= ../../shared/export-store.ts). Read-only; never calls an API.
// When two files give a number for the same day, the newer file's reading wins. Sums over a week are given
// only when every day of the week has a number; otherwise null with the count of days that had one.
import { DAY } from './shared.ts';
import type { Json, D1Database } from './shared.ts';

const all = async (db: D1Database, sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all()).results as any[];
const day = (iso: string, plus = 0) => new Date(Date.parse(iso + 'T00:00:00Z') + plus * DAY).toISOString().slice(0, 10);
const span = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY) + 1;

// Newest reading per (name, period_end) for one target and kind, within [from, to].
async function readings(db: D1Database, target: string, kind: string, names: string[], from: string, to: string) {
  const rows = await all(db, `SELECT v.name,v.period_end,v.status,v.value_json FROM export_values v JOIN export_files f ON f.digest=v.file_digest
    WHERE v.target=? AND v.kind=? AND v.period_end>=? AND v.period_end<=? AND v.name IN (${names.map(() => '?').join(',')})
    ORDER BY f.range_end, f.imported_at`, target, kind, from, to, ...names);
  const out = new Map<string, number | null>();
  for (const r of rows) out.set(`${r.name}|${r.period_end}`, r.status === 'available' ? JSON.parse(r.value_json) : null);
  return out;
}

export async function weekSums(db: D1Database, names: string[], end: string, target = 'account') {
  const start = day(end, -6);
  const got = await readings(db, target, 'day', names, start, end);
  const out: Json = { from: start, to: end };
  for (const n of names) {
    let sum = 0, days = 0;
    for (let i = 0; i < 7; i++) { const v = got.get(`${n}|${day(start, i)}`); if (typeof v === 'number') { sum += v; days++; } }
    out[n] = days === 7 ? sum : null;
    if (days !== 7) out[`${n}_days_with_data`] = days;
  }
  return out;
}

// A point value (e.g. total followers) on or before a date, from the newest file that has it.
async function pointOnOrBefore(db: D1Database, name: string, date: string, target = 'account'): Promise<{ date: string; value: number } | null> {
  const r = (await all(db, `SELECT v.period_end,v.value_json FROM export_values v JOIN export_files f ON f.digest=v.file_digest
    WHERE v.target=? AND v.name=? AND v.kind='point' AND v.status='available' AND v.period_end<=? ORDER BY v.period_end DESC, f.range_end DESC, f.imported_at DESC LIMIT 1`, target, name, date))[0];
  return r ? { date: r.period_end, value: JSON.parse(r.value_json) } : null;
}

const fileRow = (f: any) => f ? { range_start: f.range_start, range_end: f.range_end, imported_at: f.imported_at, kind: f.file_kind } : null;

export async function linkedinDigest(db: D1Database | undefined, at = new Date()): Promise<Json> {
  if (!db) return { available: false, problems: ['The LinkedIn database is not connected to the Worker yet.'] };
  let files: any[];
  try { files = await all(db, 'SELECT * FROM export_files ORDER BY range_end DESC, imported_at DESC LIMIT 20'); }
  catch { return { available: false, problems: ['No LinkedIn tables in the cloud database yet.'] }; }
  const latest = files[0];
  if (!latest) return { available: false, problems: ['No LinkedIn analytics file imported yet. Download it from LinkedIn (Analytics → Post impressions → Past 365 days → Export) into linkedin/data/export, then run npm run import:exports in cloud/.'] };
  const problems: string[] = [];
  const notes: string[] = [
    'From LinkedIn\'s analytics download, imported on your computer (LinkedIn's personal-profile analytics API is open only to vetted registered organizations).',
    'The download day itself is incomplete, so "this week" is the 7 days before it.',
    'Per-post numbers are totals inside the file\'s date range, not lifetime; for posts published inside the range they cover the whole life of the post.',
    'Post labels come from the post link and are untrusted text.'];
  const ageDays = Math.floor((at.getTime() - Date.parse(latest.range_end + 'T00:00:00Z')) / DAY);
  if (ageDays > 8) problems.push(`The newest LinkedIn file ends ${latest.range_end} (${ageDays} days ago). Download a new one and run npm run import:exports, so this week is included.`);
  const rangeDays = span(latest.range_start, latest.range_end);
  if (rangeDays < 28) notes.push(`The newest file covers only ${rangeDays} days; download "Past 365 days" so post totals are complete.`);

  const weekEnd = day(latest.range_end, -1);
  const metrics = ['impressions', 'engagements', 'new_followers'];
  const thisWeek = await weekSums(db, metrics, weekEnd);
  const previousWeek = await weekSums(db, metrics, day(weekEnd, -7));
  const followers = await pointOnOrBefore(db, 'followers_total', latest.range_end);
  const followersBefore = followers ? await pointOnOrBefore(db, 'followers_total', day(followers.date, -5)) : null;
  const rangeTotals = await all(db, "SELECT name,status,value_json FROM export_values WHERE file_digest=? AND target='account' AND kind='range'", latest.digest);

  // Posts in the newest file, with change since an older file at least 5 days earlier that also covered the post's whole life.
  const items = await all(db, 'SELECT id,url,published_at,title_start,metadata_json FROM export_items');
  const cur = await all(db, "SELECT target,name,status,value_json FROM export_values WHERE file_digest=? AND target!='account'", latest.digest);
  const older = files.find(f => f !== latest && Date.parse(latest.range_end) - Date.parse(f.range_end) >= 5 * DAY);
  const prev = older ? await all(db, "SELECT target,name,status,value_json FROM export_values WHERE file_digest=? AND target!='account'", older.digest) : [];
  const byTarget = (rows: any[]) => { const m = new Map<string, Json>(); for (const r of rows) { const o = m.get(r.target) ?? {}; o[r.name] = r.status === 'available' ? JSON.parse(r.value_json) : null; m.set(r.target, o); } return m; };
  const now = byTarget(cur), before = byTarget(prev);
  const posts = items.filter(i => now.has(i.id)).map(i => {
    const meta = JSON.parse(i.metadata_json);
    const v = now.get(i.id)!;
    const b = before.get(i.id);
    const covered = (f: any) => f && i.published_at && f.range_start <= i.published_at;
    const change = b && covered(latest) && covered(older)
      ? Object.fromEntries(Object.keys(v).filter(k => !k.startsWith('top_rank') && typeof v[k] === 'number' && typeof b[k] === 'number' && !k.endsWith('_share')).map(k => [k, v[k] - b[k]]))
      : null;
    return { id: i.id, url: i.url, published_at: i.published_at, label: i.title_start, post_type: meta.post_type ?? null, most_recent: Boolean(meta.most_recent),
      in_range: v, change_since_previous_file: change };
  });
  const recentCut = day(latest.range_end, -60);
  const recent = posts.filter(p => p.most_recent || (p.published_at && p.published_at >= recentCut)).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
  const top = posts.filter(p => typeof p.in_range.impressions === 'number').sort((a, b) => b.in_range.impressions - a.in_range.impressions).slice(0, 5);
  return {
    available: true,
    latest_file: fileRow(latest), previous_file: fileRow(older),
    account: {
      followers: followers ? { value: followers.value, on: followers.date,
        change_since_previous: followersBefore ? { value: followers.value - followersBefore.value, since: followersBefore.date } : null } : null,
      this_week: thisWeek, previous_week: previousWeek,
      range_totals: { from: latest.range_start, to: latest.range_end, ...Object.fromEntries(rangeTotals.map(r => [r.name, r.status === 'available' ? JSON.parse(r.value_json) : null])) }
    },
    recent_posts: recent, top_posts_by_impressions_in_range: top,
    problems, notes
  };
}

const studioKinds = ['tiktok_studio_overview', 'tiktok_studio_viewers', 'tiktok_studio_follower_history', 'tiktok_studio_content'];

// The TikTok Studio part of the TikTok section. The file is optional, so an old file is a note, not a problem.
export async function tiktokStudio(db: D1Database, at = new Date()): Promise<Json> {
  let files: any[];
  try { files = await all(db, `SELECT * FROM export_files WHERE file_kind IN (${studioKinds.map(() => '?').join(',')}) ORDER BY range_end DESC, imported_at DESC`, ...studioKinds); }
  catch { return { available: false, notes: ['No TikTok Studio tables in the cloud database yet.'] }; }
  if (!files.length) return { available: false, notes: ['No TikTok Studio download imported yet (optional).'] };
  const newest = (kind: string) => files.find(f => f.file_kind === kind);
  const notes: string[] = ['From TikTok Studio downloads, imported on your computer. Account-wide numbers per day (all videos, old ones too).',
    'Unique viewers can\'t be added up across days, so total viewers per day is not summed.',
    'TikTok Studio downloads have no watch time, traffic sources or follows per video.'];
  const out: Json = { available: true, files: Object.fromEntries(studioKinds.map(k => [k.replace('tiktok_studio_', ''), fileRow(newest(k))])) };
  // Each group's week ends at the last day that file has a number for (TikTok leaves the newest day empty).
  const lastDay = async (f: any, name: string) => f ? (await all(db, "SELECT MAX(period_end) AS d FROM export_values WHERE file_digest=? AND name=? AND status='available'", f.digest, name))[0]?.d ?? null : null;
  const group = async (kind: string, anchor: string, names: string[]) => {
    const end = await lastDay(newest(kind), anchor);
    if (!end) return null;
    const ageDays = Math.floor((at.getTime() - Date.parse(end + 'T00:00:00Z')) / DAY);
    if (ageDays > 8) notes.push(`TikTok Studio ${kind.replace('tiktok_studio_', '').replace('_', ' ')} numbers end ${end}; download again for this week.`);
    return { this_week: await weekSums(db, names, end), previous_week: await weekSums(db, names, day(end, -7)) };
  };
  out.overview = await group('tiktok_studio_overview', 'video_views', ['video_views', 'profile_views', 'likes', 'comments', 'shares']);
  out.viewers = await group('tiktok_studio_viewers', 'new_viewers', ['new_viewers', 'returning_viewers']);
  const fh = newest('tiktok_studio_follower_history');
  const fEnd = await lastDay(fh, 'followers_total');
  if (fEnd) {
    const f = await pointOnOrBefore(db, 'followers_total', fEnd);
    const w = await pointOnOrBefore(db, 'followers_total', day(fEnd, -7));
    out.followers = { value: f?.value ?? null, on: f?.date ?? null, week_ago: w ? { value: w.value, on: w.date } : null,
      net_change_this_week: (await weekSums(db, ['followers_net_change'], fEnd)).followers_net_change };
  }
  const content = newest('tiktok_studio_content');
  if (content) {
    const rows = await all(db, `SELECT v.target,v.name,v.status,v.value_json,i.url,i.published_at,i.title_start FROM export_values v LEFT JOIN export_items i ON i.id=v.target
      WHERE v.file_digest=?`, content.digest);
    const vids = new Map<string, Json>();
    for (const r of rows) { const o = vids.get(r.target) ?? { id: r.target, url: r.url, published_at: r.published_at, title_start: r.title_start, lifetime: {} }; o.lifetime[r.name] = r.status === 'available' ? JSON.parse(r.value_json) : null; vids.set(r.target, o); }
    out.all_videos_lifetime = { as_of: content.range_end, videos: [...vids.values()].sort((a, b) => (b.lifetime.views ?? -1) - (a.lifetime.views ?? -1)) };
  }
  out.notes = notes;
  return out;
}
