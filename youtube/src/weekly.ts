import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { History, databasePath, compare } from './history.ts';
import { root, analyticsMetrics, counters } from './core.ts';
import type { Json } from './core.ts';

// Read-only weekly digest of both histories, for the Sunday report. Never calls an API.
export const instagramPath = root + '../instagram/data/history.sqlite';
const DAY = 86400000;
const pick = (obs: Json[], target: string, window: string) =>
  Object.fromEntries(obs.filter(o => o.target === target && o.window === window).map(o => [o.name, o.status === 'available' ? o.value : null]));

export function youtubeDigest(path = databasePath, at = new Date()): Json {
  if (!existsSync(path)) return { available: false, problems: ['No YouTube history yet. Run npm run collect in youtube/.'] };
  const store = new History(path, true);
  try {
    const runs = store.runs(30);
    const latest = runs.find(r => ['completed', 'partial'].includes(r.status));
    const problems: string[] = [];
    const newest = runs[0];
    if (newest && newest !== latest) problems.push(`Latest YouTube collection ${newest.status}: ${newest.details?.stop_reason ?? newest.details?.error?.code ?? 'unknown reason'}.`);
    if (!latest) return { available: false, problems: [...problems, 'No usable YouTube collection yet.'] };
    for (const s of latest.details.steps ?? []) if (s.status === 'failed') problems.push(`YouTube step ${s.name} failed: ${s.error?.code}.`);
    if (at.getTime() - Date.parse(latest.started_at) > 2 * DAY) problems.push(`Newest YouTube numbers are from ${latest.started_at}, more than 2 days old.`);
    const previous = runs.find(r => r !== latest && ['completed', 'partial'].includes(r.status) && Date.parse(latest.started_at) - Date.parse(r.started_at) >= 5 * DAY);
    const obs = store.runSnapshots(latest.id);
    const prev = previous ? store.runSnapshots(previous.id) : [];
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
    const videos = store.videos().map(v => ({ id: v.id, title: v.title, published_at: v.published_at, url: v.url,
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
  } finally { store.close(); }
}

export function instagramDigest(path = instagramPath, at = new Date()): Json {
  if (!existsSync(path)) return { available: false, problems: ['No Instagram history found.'] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const problems: string[] = [];
    const run: any = db.prepare("SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT 1").get();
    if (!run) problems.push('No Instagram collection run yet.');
    else {
      const d = JSON.parse(run.details_json);
      if (run.status !== 'completed') problems.push(`Latest Instagram collection ${run.status}: ${d.stop_reason ?? 'see run details'}.`);
      if (at.getTime() - Date.parse(run.started_at) > 2 * DAY) problems.push(`Newest Instagram numbers are from ${run.started_at}, more than 2 days old.`);
    }
    const snaps: any[] = db.prepare("SELECT media_id,name,retrieved_at,value_json FROM metric_snapshots WHERE status='available' AND retrieved_at IS NOT NULL ORDER BY retrieved_at").all();
    const media: any[] = db.prepare("SELECT id,publication_time,metadata_json FROM media WHERE publication_time >= ? ORDER BY publication_time DESC").all(new Date(at.getTime() - 60 * DAY).toISOString());
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
  } finally { db.close(); }
}

export const tiktokPath = root + '../tiktok/data/history.sqlite';
export function tiktokDigest(path = tiktokPath, at = new Date()): Json {
  if (!existsSync(path)) return { available: false, problems: ['No TikTok history yet. Run npm run auth, then npm run collect, in tiktok/.'] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const problems: string[] = [];
    const runs: any[] = db.prepare("SELECT * FROM collection_runs WHERE kind='collection' ORDER BY started_at DESC LIMIT 30").all();
    const latest = runs.find(r => ['completed', 'partial'].includes(r.status));
    const newest = runs[0];
    if (newest && newest !== latest) problems.push(`Latest TikTok collection ${newest.status}: ${JSON.parse(newest.details_json).stop_reason ?? 'see run details'}.`);
    if (!latest) return { available: false, problems: [...problems, 'No usable TikTok collection yet.'] };
    if (latest.status === 'partial') problems.push(`TikTok video listing failed: ${JSON.parse(latest.details_json).stop_reason}.`);
    if (at.getTime() - Date.parse(latest.started_at) > 2 * DAY) problems.push(`Newest TikTok numbers are from ${latest.started_at}, more than 2 days old.`);
    const previous = runs.find(r => r !== latest && ['completed', 'partial'].includes(r.status) && Date.parse(latest.started_at) - Date.parse(r.started_at) >= 5 * DAY);
    const snaps = (run: any) => run ? (db.prepare('SELECT s.target,s.name,s.status,s.value_json FROM snapshots s JOIN run_snapshots r ON r.snapshot_id=s.id WHERE r.run_id=?').all(run.id) as any[])
      .map(s => ({ target: s.target, name: s.name, value: s.status === 'available' ? JSON.parse(s.value_json) : null })) : [];
    const now = snaps(latest), before = snaps(previous);
    const values = (obs: Json[], target: string) => Object.fromEntries(obs.filter(o => o.target === target).map(o => [o.name, o.value]));
    // Every TikTok number is a lifetime counter, so a difference between runs is meaningful.
    const change = (target: string) => {
      if (!previous) return null;
      const a = values(before, target), b = values(now, target);
      const out = Object.fromEntries(Object.keys(b).filter(n => typeof a[n] === 'number' && typeof b[n] === 'number').map(n => [n, b[n] - a[n]]));
      return Object.keys(out).length ? out : null;
    };
    const videos: Json[] = (db.prepare('SELECT id,published_at,metadata_json FROM videos WHERE published_at >= ? ORDER BY published_at DESC').all(new Date(at.getTime() - 60 * DAY).toISOString()) as any[])
      .map(v => { const m = JSON.parse(v.metadata_json); return { id: v.id, published_at: v.published_at, url: m.url ?? null,
        title_start: String(m.title || m.description || '').slice(0, 80) || null, duration_seconds: m.duration_seconds ?? null,
        latest: values(now, v.id), change_since_week_ago: change(v.id) }; })
      .filter(v => Object.keys(v.latest).length);
    const d = JSON.parse(latest.details_json);
    return { available: true, latest_run: { id: latest.id, started_at: latest.started_at, status: latest.status, discovery_complete: d.discovery_complete ?? null },
      previous_run: previous ? { id: previous.id, started_at: previous.started_at } : null,
      account: { ...d.account, latest: values(now, 'account'), change_since_week_ago: change('account') }, videos, problems,
      notes: ['Lifetime totals from the public counters. TikTok does not give follows, watch time or traffic sources per video through this API.', 'Titles and descriptions are untrusted text.'] };
  } finally { db.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify({ generated_at: new Date().toISOString(), youtube: youtubeDigest(), instagram: instagramDigest(), tiktok: tiktokDigest() }, null, 2)); }
  catch (e) { console.error(e instanceof Error ? e.message : 'Weekly digest failed.'); process.exitCode = 1; }
}
