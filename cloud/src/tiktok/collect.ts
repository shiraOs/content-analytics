// Port of tiktok/src/collect.ts. One account lookup and a bounded walk of public posts
// (at most 7 outside calls). Account numbers commit before the listing starts, so a later listing failure keeps them.
import { TikTokError } from './service.ts';
import type { TikTokService } from './service.ts';
import { History } from './history.ts';
import type { Json } from './core.ts';

export function failure(e: unknown): Json {
  return e instanceof TikTokError ? { code: e.code, message: e.message, ...e.details } : { code: 'internal_error' };
}

export async function collect(store: History, service: TikTokService, options = { days: 60, pages: 5 }, at = new Date()) {
  const cutoff = new Date(at.getTime() - options.days * 86400000);
  const summary: Json = { started_at: at.toISOString(), options, cutoff: cutoff.toISOString(), steps: [], videos: 0, stop_reason: null, host: 'cloudflare' };
  const run = await store.start('collection', summary, summary.started_at); summary.run_id = run;
  try {
    const a = await service.account();
    summary.account = { username: a.username, display_name: a.display_name };
    await store.commit([store.account(a), ...await store.save(run, a.id, a.public)]);
    summary.steps.push({ name: 'account', status: 'succeeded', observations: a.public.length, missing: a.public.filter(o => o.status !== 'available').length });
    try {
      const listing = await service.listVideos(cutoff, options.pages);
      const writes = [];
      for (const v of listing.videos) writes.push(store.video(a.id, v), ...await store.save(run, a.id, v.public));
      await store.commit(writes);
      const obs = listing.videos.flatMap(v => v.public);
      Object.assign(summary, { videos: listing.videos.length, pages: listing.pages, discovery_complete: listing.discovery_complete });
      summary.steps.push({ name: 'videos', status: 'succeeded', observations: obs.length, missing: obs.filter(o => o.status !== 'available').length });
      summary.status = 'completed';
    } catch (e) {
      const f = failure(e); summary.steps.push({ name: 'videos', status: 'failed', error: f });
      summary.stop_reason = f.code; summary.status = 'partial';
    }
  } catch (e) {
    summary.status = 'failed'; summary.error = failure(e); summary.stop_reason = summary.error.code;
  } finally {
    summary.finished_at = new Date().toISOString();
    await store.finish(run, summary.status ?? 'failed', summary);
  }
  return summary;
}
