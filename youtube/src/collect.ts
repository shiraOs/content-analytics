import { createYouTubeService, YouTubeError, windows } from './service.ts';
import type { YouTubeService } from './service.ts';
import { History, writerLock } from './history.ts';
import { analyticsMetrics, counters, unit } from './core.ts';
import type { Json } from './core.ts';

const stopCodes = ['quota_exceeded', 'authentication_failed', 'account_mismatch', 'not_configured', 'network_error'];
function failure(e: unknown): Json {
  return e instanceof YouTubeError ? { code: e.code, message: e.message, ...e.details } : { code: 'internal_error' };
}
const metric = (target: string, w: Json, name: string, value: unknown, retrieved_at: string, extra: Json = {}) => ({
  target, window: w.name, start_date: w.start, end_date: w.end, name, unit: unit(name), retrieved_at, source: 'analytics',
  status: typeof value === 'number' && Number.isFinite(value) ? 'available' : 'missing', value: typeof value === 'number' ? value : null, ...extra });
// Shorts are 3 minutes or less; used only when Analytics will not say which uploads are Shorts.
const guessType = (v: Json) => v.duration_seconds !== null && v.duration_seconds <= 180 ? 'SHORTS' : 'VIDEO_ON_DEMAND';

export async function collect(store: History, service: YouTubeService = createYouTubeService(), signal?: AbortSignal, at = new Date()) {
  const summary: Json = { started_at: at.toISOString(), steps: [], videos: 0, stop_reason: null };
  const run = store.start('collection', summary, summary.started_at); summary.run_id = run;
  let channelId = '';
  // Each step commits on its own, so a later failure keeps earlier numbers.
  async function step(name: string, action: () => Promise<Json[]>) {
    if (summary.stop_reason) return;
    if (signal?.aborted) { summary.stop_reason = 'interrupted'; return; }
    try {
      const obs = await action();
      store.transaction(() => store.save(run, channelId, obs));
      summary.steps.push({ name, status: 'succeeded', observations: obs.length, missing: obs.filter(o => o.status !== 'available').length });
    } catch (e) {
      const f = failure(e); summary.steps.push({ name, status: 'failed', error: f });
      if (stopCodes.includes(f.code)) summary.stop_reason = f.code;
    }
  }
  try {
    const listing = await service.listVideos();
    const ch = listing.channel; channelId = ch.id;
    summary.channel = { id: ch.id, title: ch.title, handle: ch.handle };
    summary.videos = listing.videos.length; summary.discovery_complete = listing.discovery_complete;
    const [lifetime, week] = windows(ch.published_at, at);
    summary.windows = { lifetime, last_7_days: week };
    const types = new Map<string, Json>();
    store.transaction(() => {
      store.channel(ch);
      for (const v of listing.videos) store.video(ch.id, v);
      store.save(run, ch.id, [...ch.public, ...listing.videos.flatMap(v => v.public)]);
    });
    summary.steps.push({ name: 'public_stats', status: 'succeeded', observations: ch.public.length + listing.videos.length * 3 });
    await step('content_type', async () => {
      const shorts = await service.shortIds(lifetime);
      for (const v of listing.videos) {
        // Uploads with no views never appear in the Shorts report, so those fall back to the duration guess.
        const unseen = shorts === null || (!shorts.has(v.id) && v.public.find((o: Json) => o.name === 'viewCount')?.value === 0);
        types.set(v.id, unseen ? { content_type: guessType(v), type_source: 'duration_guess' }
          : { content_type: shorts!.has(v.id) ? 'SHORTS' : 'VIDEO_ON_DEMAND', type_source: 'analytics' });
      }
      store.transaction(() => { for (const v of listing.videos) store.video(ch.id, { ...v, ...types.get(v.id) }); });
      return [];
    });
    for (const w of [lifetime, week]) await step(`videos_${w.name}`, async () => {
      const report = await service.videoMetrics(w);
      const byId = new Map(report.rows.map(r => [r.video, r]));
      // Absent from the report = no activity in the window, unless it's past the 200-row cap
      // or so new that Analytics (2–3 day lag) has nothing yet; those stay missing, not zero.
      const settled = (v: Json) => byId.size < 200 && v.published_at && at.getTime() - Date.parse(v.published_at) > 3 * 86400000;
      return listing.videos.flatMap(v => analyticsMetrics.map(name => metric(v.id, w, name, byId.get(v.id)?.[name] ?? (settled(v) && counters.includes(name) ? 0 : null), report.retrieved_at,
        { dimension: 'video', ...types.get(v.id), absent_from_report: !byId.has(v.id) })));
    });
    for (const w of [lifetime, week]) await step(`channel_${w.name}`, async () => {
      const t = await service.channelTotals(w);
      return [...analyticsMetrics.map(name => metric('channel', w, name, t.total?.[name], t.retrieved_at)),
        ...t.by_type.flatMap(row => analyticsMetrics.map(name => metric(`channel:${row.creatorContentType}`, w, name, row[name], t.retrieved_at, { dimension: 'creatorContentType', content_type: row.creatorContentType })))];
    });
    // Where views came from, for uploads in their first 28 days.
    const recent = listing.videos.filter(v => v.published_at && at.getTime() - Date.parse(v.published_at) <= 28 * 86400000).slice(0, 10);
    for (const v of recent) await step(`traffic_${v.id}`, async () => {
      const w = { name: 'lifetime', start: String(v.published_at).slice(0, 10), end: lifetime.end };
      const t = await service.trafficSources(v.id, w);
      return t.rows.map(r => metric(`${v.id}:traffic:${r.insightTrafficSourceType}`, w, 'views', r.views, t.retrieved_at, { dimension: 'insightTrafficSourceType' }));
    });
    summary.status = summary.stop_reason === 'interrupted' ? 'interrupted' : summary.steps.some((s: Json) => s.status === 'failed') ? 'partial' : 'completed';
  } catch (e) {
    summary.status = 'failed'; summary.error = failure(e); summary.stop_reason = summary.error.code;
  } finally {
    summary.finished_at = new Date().toISOString();
    store.finish(run, summary.status ?? 'failed', summary);
  }
  return summary;
}
if (import.meta.main) {
  let release: (() => void) | undefined; let store: History | undefined;
  const controller = new AbortController(); const stop = () => controller.abort();
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    process.umask(0o077); release = writerLock(); store = new History(); store.recover();
    const result = await collect(store, undefined, controller.signal);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'completed' ? 0 : result.status === 'interrupted' ? 130 : 2;
  } catch (e) { console.error(JSON.stringify({ error: failure(e) })); process.exitCode = e instanceof YouTubeError && e.code === 'collection_busy' ? 75 : 1; }
  finally { store?.close(); release?.(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
