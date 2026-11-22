// Port of instagram/src/collect.ts, split for the 50-call free-plan limit:
// discover() verifies the account and lists owned media (≤ 6 calls), then each batch()
// verifies the account again and fetches up to 5 Reels (1 + 5 × 8 = 41 calls). One run spans them all.
import { InstagramError } from './service.ts';
import type { InstagramService } from './service.ts';
import { History } from './history.ts';
import { metrics } from './core.ts';
import type { Json } from './core.ts';
import { validTime } from '../shared.ts';

export type Options = { days:number; pages:number; pageSize:number; reels:number };
export const defaults: Options = {days:30,pages:5,pageSize:25,reels:25};
export const batchSize = 5;
const bounds = {days:30,pages:20,pageSize:50,reels:100};
export function validateOptions(o: Options) {
  for (const key of Object.keys(bounds) as (keyof Options)[]) if (!Number.isInteger(o[key]) || o[key]<1 || o[key]>bounds[key]) throw new Error(`Invalid ${key}: expected integer 1–${bounds[key]}`);
}
const rateLimited = (m: Json) => m.http_status === 429 || [4,17,32,613,80002].includes(m.error?.code);
const stopCodes = ['authentication_failed','account_mismatch','not_configured'];
export function failure(e: unknown): Json {
  return e instanceof InstagramError ? {code:e.code,...e.details} : {code:'internal_error'};
}
export type State = { run_id: string; summary: Json; queue: Json[] };

export async function discover(store: History, service: InstagramService, options: Options = defaults, at = new Date(), token_check: Json | null = null): Promise<State> {
  validateOptions(options);
  const summary: Json = {options,cutoff:new Date(at.getTime()-options.days*86400000).toISOString(),started_at:at.toISOString(),pages:0,discovered:0,items:[],discovery_complete:false,discovery_error:null,stop_reason:null,host:'cloudflare',token_check};
  const run = await store.start('collection',summary); summary.run_id = run;
  const queue: Json[] = [];
  const seen = new Set<string>(); let after: string | undefined; const cursors = new Set<string>();
  try {
    const session = await service.session();
    discovery: for (let page=0;page<options.pages;page++) {
      let listing: Json;
      try { listing = await service.listRecentMedia(session,options.pageSize,after); }
      catch (e) { summary.discovery_error=failure(e); break; }
      summary.pages++;
      const writes = [];
      for (const media of listing.media) {
        if (seen.has(media.id)) continue;
        seen.add(media.id); summary.discovered++;
        writes.push(...store.media(listing.account,media));
        if (media.media_product_type !== 'REELS') continue;
        if (!validTime(media.timestamp)) { summary.items.push({media_id:media.id,status:'skipped',reason:'unknown_publication_time'}); continue; }
        if (Date.parse(media.timestamp)<Date.parse(summary.cutoff) || Date.parse(media.timestamp)>at.getTime()) continue;
        if (queue.length>=options.reels) { summary.stop_reason='reel_limit'; await store.commit(writes); break discovery; }
        queue.push(media);
      }
      await store.commit(writes);
      if (!listing.pagination.has_next_page) { summary.discovery_complete=true; break; }
      after = listing.pagination.after;
      if (!after || cursors.has(after)) { summary.stop_reason='repeated_or_missing_cursor'; break; }
      cursors.add(after);
    }
  } catch (e) {
    // The account itself could not be verified: nothing to fetch.
    summary.discovery_error = failure(e);
    if (stopCodes.includes(summary.discovery_error.code)) summary.stop_reason = summary.discovery_error.code;
  }
  if (!summary.discovery_complete && !summary.stop_reason && !summary.discovery_error) summary.stop_reason='page_limit';
  return { run_id: run, summary, queue };
}

// Each Reel's observations and item outcome commit atomically. Rate limits and sign-in problems stop
// the rest of the run (remaining Reels are not attempted); there are no retries.
export async function batch(store: History, service: InstagramService, state: State, size = batchSize): Promise<State> {
  const { run_id: run, summary } = state;
  const reels = state.queue.slice(0, size); let queue = state.queue.slice(size);
  let session: { c: Json; account: Json } | null = null; let sessionError: Json | null = null;
  try { session = await service.session(); } catch (e) { sessionError = failure(e); }
  for (const media of reels) {
    await store.item(run,media.id,'pending').run();
    try {
      if (!session) { const { code, ...details } = sessionError!; throw new InstagramError(code, 'Account verification failed.', details); }
      const observation = await service.getReelInsights(session, media);
      const supported = observation.metrics.filter((m: Json)=>metrics.includes(m.name));
      const bad = supported.filter((m: Json)=>m.status !== 'available');
      const item: Json = {media_id:media.id,status:bad.length ? (supported.some((m: Json)=>m.status === 'available') ? 'partial':'failed'):'succeeded',metrics:observation.metrics.map((m: Json)=>({name:m.name,status:m.status})),failures:bad.map((m: Json)=>({name:m.name,status:m.status,http_status:m.http_status,meta_code:m.error?.code ?? null}))};
      await store.commit([...await store.save(run,observation), store.item(run,media.id,item.status,item)]);
      summary.items.push(item);
      if (supported.some(rateLimited)) { summary.stop_reason='rate_limited'; queue = []; break; }
      if (supported.some((m: Json)=>m.status==='authentication_failed')) { summary.stop_reason='authentication_failed'; queue = []; break; }
    } catch (e) {
      const item = {media_id:media.id,status:'failed',error:failure(e)};
      await store.item(run,media.id,'failed',item).run(); summary.items.push(item);
      if ([429].includes(item.error.http_status) || [4,17,32,613,80002].includes(item.error.meta_code)) { summary.stop_reason='rate_limited'; queue = []; break; }
      if (stopCodes.includes(item.error.code)) { summary.stop_reason=item.error.code; queue = []; break; }
    }
  }
  return { run_id: run, summary, queue };
}

export async function finish(store: History, state: State) {
  const summary = state.summary;
  summary.status = summary.discovery_error || summary.items.some((m: Json)=>['failed','partial'].includes(m.status)) || ['rate_limited','authentication_failed','repeated_or_missing_cursor','account_mismatch','not_configured'].includes(summary.stop_reason) ? 'partial' : 'completed';
  summary.finished_at=new Date().toISOString();
  summary.counts=Object.fromEntries(['succeeded','partial','failed','skipped','interrupted'].map(status=>[status,summary.items.filter((item: Json)=>item.status===status).length]));
  await store.finish(state.run_id,summary.status,summary);
  return summary;
}
