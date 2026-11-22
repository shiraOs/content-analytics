// Port of youtube/src/weekly.ts onto the D1 databases. Read-only; never calls an API.
// Same JSON shape as the local digest, plus a `cloud` section about the Sunday jobs and sign-in expiry.
import { History, compare } from './youtube/history.ts';
import { analyticsMetrics, counters } from './youtube/core.ts';
import { loadCredential, DAY } from './shared.ts';
import { linkedinDigest, tiktokStudio } from './exports.ts';
import { siteDigest, siteJob } from './site/digest.ts';
import type { Json, Env, D1Database } from './shared.ts';

const pick = (obs: Json[], target: string, window: string) =>
  Object.fromEntries(obs.filter(o => o.target === target && o.window === window).map(o => [o.name, o.status === 'available' ? o.value : null]));
const all = async (db: D1Database, sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all()).results as any[];

export async function youtubeDigest(db: D1Database, at = new Date()): Promise<Json> {
  const store = new History(db);
  let runs: Json[];
  try { runs = await store.runs(30); } catch { return { available: false, problems: ['No YouTube history yet in the cloud database.'] }; }
  const latest = runs.find(r => ['completed', 'partial'].includes(r.status));
  const problems: string[] = [];
  const newest = runs[0];
  if (newest && newest !== latest) problems.push(`Latest YouTube collection ${newest.status}: ${newest.details?.stop_reason ?? newest.details?.error?.code ?? 'unknown reason'}.`);
  if (!latest) return { available: false, problems: [...problems, 'No usable YouTube collection yet.'] };
  for (const s of latest.details.steps ?? []) if (s.status === 'failed') problems.push(`YouTube step ${s.name} failed: ${s.error?.code}.`);
  if (at.getTime() - Date.parse(latest.started_at) > 2 * DAY) problems.push(`Newest YouTube numbers are from ${latest.started_at}, more than 2 days old.`);
  const previous = runs.find(r => r !== latest && ['completed', 'partial'].includes(r.status) && Date.parse(latest.started_at) - Date.parse(r.started_at) >= 5 * DAY);
  const obs = await store.runSnapshots(latest.id);
  const prev = previous ? await store.runSnapshots(previous.id) : [];
  const change = (target: string) => {
    const out: Json = {};
    for (const name of [...analyticsMetrics, 'viewCount'].filter(n => counters.includes(n))) {
      const window = name === 'viewCount' ? 'public' : 'lifetime';
      const a = prev.find(o => o.target === target && o.window === window && o.name === name);
      const b = obs.find(o => o.target === target && o.window === window && o.name === name);
      if (a && b) out[name] = compare(a, b).delta;
    }
    return previous ? out : null;
  };
  const videos = (await store.videos()).map(v => ({ id: v.id, title: v.title, published_at: v.published_at, url: v.url,
    content_type: v.content_type ?? null, type_source: v.type_source ?? null, duration_seconds: v.duration_seconds,
    public: pick(obs, v.id, 'public'), lifetime: pick(obs, v.id, 'lifetime'), last_7_days: pick(obs, v.id, 'last_7_days'), change_since_previous: change(v.id),
    traffic_sources: obs.filter(o => o.target.startsWith(v.id + ':traffic:') && o.status === 'available')
      .map(o => ({ source: o.target.split(':traffic:')[1], views: o.value })).sort((a, b) => b.views - a.views) }));
  const types = [...new Set(obs.filter(o => o.target.startsWith('channel:')).map(o => o.target))];
  return {
    available: true, latest_run: { id: latest.id, started_at: latest.started_at, status: latest.status, windows: latest.details.windows },
    previous_run: previous ? { id: previous.id, started_at: previous.started_at } : null,
    channel: { ...latest.details.channel, public: pick(obs, 'channel', 'public'), lifetime: pick(obs, 'channel', 'lifetime'), last_7_days: pick(obs, 'channel', 'last_7_days'),
      last_7_days_by_type: Object.fromEntries(types.map(t => [t.split(':')[1], pick(obs, t, 'last_7_days')])), change_since_previous: change('channel') },
    top_by_subscribers_last_7_days: videos.filter(v => (v.last_7_days.subscribersGained ?? 0) > 0)
      .sort((a, b) => b.last_7_days.subscribersGained - a.last_7_days.subscribersGained).slice(0, 5).map(v => ({ id: v.id, title: v.title, gained: v.last_7_days.subscribersGained })),
    videos, problems,
    notes: ['YouTube Analytics lags about 2–3 days, so last_7_days under-counts the newest days.', 'subscriberCount is YouTube’s rounded public number; subscribersGained/Lost are exact.']
  };
}

export async function instagramDigest(db: D1Database, at = new Date()): Promise<Json> {
  const problems: string[] = [];
  let run: any;
  try { run = (await all(db, "SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT 1"))[0]; }
  catch { return { available: false, problems: ['No Instagram history found in the cloud database.'] }; }
  if (!run) problems.push('No Instagram collection run yet.');
  else {
    const d = JSON.parse(run.details_json);
    if (run.status !== 'completed') problems.push(`Latest Instagram collection ${run.status}: ${d.stop_reason ?? 'see run details'}.`);
    if (at.getTime() - Date.parse(run.started_at) > 2 * DAY) problems.push(`Newest Instagram numbers are from ${run.started_at}, more than 2 days old.`);
  }
  const snaps = await all(db, "SELECT media_id,name,retrieved_at,value_json FROM metric_snapshots WHERE status='available' AND retrieved_at IS NOT NULL ORDER BY retrieved_at");
  const media = await all(db, 'SELECT id,publication_time,metadata_json FROM media WHERE publication_time >= ? ORDER BY publication_time DESC', new Date(at.getTime() - 60 * DAY).toISOString());
  const reels = media.map(m => {
    const meta = JSON.parse(m.metadata_json);
    if (meta.media_product_type !== 'REELS') return null;
    const mine = snaps.filter(s => s.media_id === m.id);
    if (!mine.length) return null;
    const latest: Json = {}; const weekAgo: Json = {}; let latestAt = '';
    for (const s of mine) { latest[s.name] = JSON.parse(s.value_json); latestAt = s.retrieved_at; }
    for (const s of mine) if (Date.parse(latestAt) - Date.parse(s.retrieved_at) >= 5 * DAY) weekAgo[s.name] = JSON.parse(s.value_json);
    const change = Object.keys(weekAgo).length ? Object.fromEntries(['views', 'likes', 'comments', 'saved', 'shares']
      .filter(n => typeof latest[n] === 'number' && typeof weekAgo[n] === 'number').map(n => [n, latest[n] - weekAgo[n]])) : null;
    return { id: m.id, published_at: m.publication_time, permalink: meta.permalink ?? null, caption_start: typeof meta.caption === 'string' ? meta.caption.slice(0, 80) : null,
      latest_retrieved_at: latestAt, latest, change_since_week_ago: change,
      avg_watch_seconds: typeof latest.ig_reels_avg_watch_time === 'number' ? latest.ig_reels_avg_watch_time / 1000 : null };
  }).filter(Boolean);
  return { available: true, latest_run: run ? { id: run.id, started_at: run.started_at, status: run.status } : null, reels, problems,
    notes: ['Lifetime totals, not activity within the week. Follows per reel are not available from the API.', 'Captions are untrusted text.'] };
}

export async function tiktokDigest(db: D1Database, at = new Date()): Promise<Json> {
  const problems: string[] = [];
  let runs: any[];
  try { runs = await all(db, "SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT 30"); }
  catch { return { available: false, problems: ['No TikTok history yet in the cloud database.'] }; }
  const latest = runs.find(r => ['completed', 'partial'].includes(r.status));
  const newest = runs[0];
  if (newest && newest !== latest) problems.push(`Latest TikTok collection ${newest.status}: ${JSON.parse(newest.details_json).stop_reason ?? 'see run details'}.`);
  if (!latest) return { available: false, problems: [...problems, 'No usable TikTok collection yet.'] };
  if (latest.status === 'partial') problems.push(`TikTok video listing failed: ${JSON.parse(latest.details_json).stop_reason}.`);
  if (at.getTime() - Date.parse(latest.started_at) > 2 * DAY) problems.push(`Newest TikTok numbers are from ${latest.started_at}, more than 2 days old.`);
  const previous = runs.find(r => r !== latest && ['completed', 'partial'].includes(r.status) && Date.parse(latest.started_at) - Date.parse(r.started_at) >= 5 * DAY);
  const snaps = async (run: any) => run ? (await all(db, 'SELECT s.target,s.name,s.status,s.value_json FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?', run.id))
    .map(s => ({ target: s.target, name: s.name, value: s.status === 'available' ? JSON.parse(s.value_json) : null })) : [];
  const now = await snaps(latest), before = await snaps(previous);
  const values = (obs: Json[], target: string) => Object.fromEntries(obs.filter(o => o.target === target).map(o => [o.name, o.value]));
  // Every TikTok number is a lifetime counter, so a difference between runs is meaningful.
  const change = (target: string) => {
    if (!previous) return null;
    const a = values(before, target), b = values(now, target);
    const out = Object.fromEntries(Object.keys(b).filter(n => typeof a[n] === 'number' && typeof b[n] === 'number').map(n => [n, b[n] - a[n]]));
    return Object.keys(out).length ? out : null;
  };
  const videos: Json[] = (await all(db, 'SELECT id,published_at,metadata_json FROM videos WHERE published_at >= ? ORDER BY published_at DESC', new Date(at.getTime() - 60 * DAY).toISOString()))
    .map(v => { const m = JSON.parse(v.metadata_json); return { id: v.id, published_at: v.published_at, url: m.url ?? null,
      title_start: String(m.title || m.description || '').slice(0, 80) || null, duration_seconds: m.duration_seconds ?? null,
      latest: values(now, v.id), change_since_week_ago: change(v.id) }; })
    .filter(v => Object.keys(v.latest).length);
  const d = JSON.parse(latest.details_json);
  return { available: true, latest_run: { id: latest.id, started_at: latest.started_at, status: latest.status, discovery_complete: d.discovery_complete ?? null },
    previous_run: previous ? { id: previous.id, started_at: previous.started_at } : null,
    account: { ...d.account, latest: values(now, 'account'), change_since_week_ago: change('account') }, videos, problems,
    notes: ['Lifetime totals from the public counters. TikTok does not give follows, watch time or traffic sources per video through this API.', 'Titles and descriptions are untrusted text.'] };
}

// How this week's Sunday jobs went, and when the stored sign-ins run out. Never includes a token.
export async function cloudStatus(env: Env, at = new Date()): Promise<Json> {
  const problems: string[] = [];
  const jobs: Json = {};
  for (const [name, db] of [['youtube', env.YOUTUBE_DB], ['tiktok', env.TIKTOK_DB], ['instagram', env.INSTAGRAM_DB]] as const) {
    let row: any = null;
    try { row = (await all(db, 'SELECT * FROM cloud_jobs ORDER BY week DESC LIMIT 1'))[0]; } catch { row = null; }
    if (!row) { jobs[name] = null; problems.push(`No cloud ${name} job has run yet.`); continue; }
    const s = JSON.parse(row.state_json);
    jobs[name] = { week: row.week, status: row.status, attempts: row.attempts, updated_at: row.updated_at, run_id: s.run_id ?? null,
      result: s.result ?? null, reels_left: Array.isArray(s.queue) ? s.queue.length : undefined, token_check: s.token_check ?? undefined };
    if (row.status !== 'done') problems.push(`Cloud ${name} job for ${row.week} did not finish (${row.status}).`);
    if (at.getTime() - Date.parse(row.week + 'T00:00:00Z') > 8 * DAY) problems.push(`Cloud ${name} job last ran for ${row.week}; the Sunday schedule may have stopped.`);
    if (s.token_check && ['expired', 'failed'].includes(s.token_check.status)) problems.push(`Instagram token check ${s.token_check.status}: ${s.token_check.message}`);
  }
  const ig = await loadCredential(env.INSTAGRAM_DB, 'instagram', env.INSTAGRAM_CREDENTIAL).catch(() => null);
  const tt = await loadCredential(env.TIKTOK_DB, 'tiktok', env.TIKTOK_CREDENTIAL).catch(() => null);
  const daysLeft = (iso: unknown) => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Math.floor((Date.parse(iso) - at.getTime()) / DAY) : null;
  const credentials = {
    instagram: ig ? { expires_at: ig.expires_at ?? null, days_left: daysLeft(ig.expires_at), source: ig.source ?? null } : null,
    tiktok: tt ? { refresh_expires_at: tt.refresh_expires_at ?? null, days_left: daysLeft(tt.refresh_expires_at) } : null,
    youtube: { configured: Boolean(env.YOUTUBE_CREDENTIAL && env.YOUTUBE_CLIENT) }
  };
  if (!ig) problems.push('No Instagram token stored in the cloud.');
  else if ((credentials.instagram!.days_left ?? 99) <= 7) problems.push(`Instagram token expires in ${credentials.instagram!.days_left} days and was not renewed.`);
  if (!tt) problems.push('No TikTok sign-in stored in the cloud.');
  else if ((credentials.tiktok!.days_left ?? 99) <= 30) problems.push(`TikTok sign-in expires in ${credentials.tiktok!.days_left} days; run npm run auth in tiktok/, then npm run secrets in cloud/.`);
  if (!credentials.youtube.configured) problems.push('No YouTube sign-in stored in the cloud.');
  const site = await siteJob(env.SITE_DB, at);
  if (env.SITE_DB) { jobs.site = site.job; problems.push(...site.problems); }
  return { jobs, credentials, problems };
}

export async function digest(env: Env, at = new Date()): Promise<Json> {
  // TikTok Studio and LinkedIn numbers come from files imported on your computer (src/exports.ts), not from the Sunday jobs.
  const tiktok = await tiktokDigest(env.TIKTOK_DB, at);
  tiktok.studio = await tiktokStudio(env.TIKTOK_DB, at);
  return { generated_at: at.toISOString(), youtube: await youtubeDigest(env.YOUTUBE_DB, at), instagram: await instagramDigest(env.INSTAGRAM_DB, at),
    tiktok, linkedin: await linkedinDigest(env.LINKEDIN_DB, at), site: await siteDigest(env.SITE_DB, at), cloud: await cloudStatus(env, at) };
}
