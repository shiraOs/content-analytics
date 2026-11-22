import { parseArgs } from 'node:util';
import { createTikTokService, TikTokError } from './service.ts';
import type { TikTokService } from './service.ts';
import { History, writerLock } from './history.ts';
import type { Json } from './core.ts';

function failure(e: unknown): Json {
  return e instanceof TikTokError ? { code: e.code, message: e.message, ...e.details } : { code: 'internal_error' };
}

// One account lookup and a bounded walk of public posts. Account numbers commit before the
// listing starts, so a later listing failure keeps them.
export async function collect(store: History, service: TikTokService = createTikTokService(), options = { days: 60, pages: 5 }, at = new Date()) {
  const cutoff = new Date(at.getTime() - options.days * 86400000);
  const summary: Json = { started_at: at.toISOString(), options, cutoff: cutoff.toISOString(), steps: [], videos: 0, stop_reason: null };
  const run = store.start('collection', summary, summary.started_at); summary.run_id = run;
  try {
    const a = await service.account();
    summary.account = { username: a.username, display_name: a.display_name };
    store.transaction(() => { store.account(a); store.save(run, a.id, a.public); });
    summary.steps.push({ name: 'account', status: 'succeeded', observations: a.public.length, missing: a.public.filter(o => o.status !== 'available').length });
    try {
      const listing = await service.listVideos(cutoff, options.pages);
      store.transaction(() => { for (const v of listing.videos) { store.video(a.id, v); store.save(run, a.id, v.public); } });
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
    store.finish(run, summary.status ?? 'failed', summary);
  }
  return summary;
}

if (import.meta.main) {
  let release: (() => void) | undefined; let store: History | undefined;
  try {
    const { values } = parseArgs({ options: { days: { type: 'string', default: '60' }, pages: { type: 'string', default: '5' }, status: { type: 'boolean', default: false } } });
    if (values.status) {
      console.log(JSON.stringify(await createTikTokService().connectionStatus(), null, 2));
    } else {
      const days = Number(values.days), pages = Number(values.pages);
      if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isInteger(pages) || pages < 1 || pages > 20)
        throw new TikTokError('bad_arguments', '--days must be 1–365 and --pages 1–20.');
      process.umask(0o077); release = writerLock(); store = new History(); store.recover();
      const result = await collect(store, undefined, { days, pages });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.status === 'completed' ? 0 : 2;
    }
  } catch (e) { console.error(JSON.stringify({ error: failure(e) })); process.exitCode = e instanceof TikTokError && e.code === 'collection_busy' ? 75 : 1; }
  finally { store?.close(); release?.(); }
}
