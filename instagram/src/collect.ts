import { parseArgs } from 'node:util';
import { createInstagramService, InstagramError } from './service.ts';
import { History, writerLock, validTime } from './history.ts';
import { metrics } from './core.ts';
import type { Json } from './core.ts';

export type Options = { days:number; pages:number; pageSize:number; reels:number };
export const defaults: Options = {days:30,pages:5,pageSize:25,reels:25};
const bounds = {days:30,pages:20,pageSize:50,reels:100};
export function validateOptions(o: Options) {
  for (const key of Object.keys(bounds) as (keyof Options)[]) if (!Number.isInteger(o[key]) || o[key]<1 || o[key]>bounds[key]) throw new Error(`Invalid ${key}: expected integer 1–${bounds[key]}`);
}
const rateLimited = (m: Json) => m.http_status === 429 || [4,17,32,613,80002].includes(m.error?.code);
function failure(e: unknown): Json {
  return e instanceof InstagramError ? {code:e.code,...e.details} : {code:'internal_error'};
}
export async function collect(store: History, service = createInstagramService(), options: Options = defaults, signal?: AbortSignal, at = new Date()) {
  validateOptions(options);
  const summary: Json = {options,cutoff:new Date(at.getTime()-options.days*86400000).toISOString(),started_at:at.toISOString(),pages:0,discovered:0,items:[],discovery_complete:false,discovery_error:null,stop_reason:null};
  const run = store.start('collection',summary); summary.run_id = run;
  const seen = new Set<string>(); let after: string | undefined; const cursors = new Set<string>();
  try {
    discovery: for (let page=0;page<options.pages;page++) {
      if (signal?.aborted) { summary.stop_reason='interrupted'; break; }
      let listing: Json;
      try { listing = await service.listRecentMedia(options.pageSize,after); }
      catch (e) { summary.discovery_error=failure(e); break; }
      summary.pages++;
      for (const media of listing.media) {
        if (seen.has(media.id)) continue;
        seen.add(media.id); summary.discovered++;
        store.media(listing.account,media);
        if (media.media_product_type !== 'REELS') continue;
        if (!validTime(media.timestamp)) { summary.items.push({media_id:media.id,status:'skipped',reason:'unknown_publication_time'}); continue; }
        if (Date.parse(media.timestamp)<Date.parse(summary.cutoff) || Date.parse(media.timestamp)>at.getTime()) continue;
        if (summary.items.filter((m: Json)=>m.status !== 'skipped').length>=options.reels) { summary.stop_reason='reel_limit'; break discovery; }
        store.item(run,media.id,'pending');
        if (signal?.aborted) { store.item(run,media.id,'interrupted'); summary.items.push({media_id:media.id,status:'interrupted'}); summary.stop_reason='interrupted'; break discovery; }
        try {
          const observation = await service.getReelInsights(media.id);
          const supported = observation.metrics.filter((m: Json)=>metrics.includes(m.name));
          const bad = supported.filter((m: Json)=>m.status !== 'available');
          const item: Json = {media_id:media.id,status:bad.length ? (supported.some((m: Json)=>m.status === 'available') ? 'partial':'failed'):'succeeded',metrics:observation.metrics.map((m: Json)=>({name:m.name,status:m.status})),failures:bad.map((m: Json)=>({name:m.name,status:m.status,http_status:m.http_status,meta_code:m.error?.code ?? null}))};
          store.transaction(()=> { store.save(run,observation); store.item(run,media.id,item.status,item); });
          summary.items.push(item);
          if (supported.some(rateLimited)) { summary.stop_reason='rate_limited'; break discovery; }
          if (supported.some((m: Json)=>m.status==='authentication_failed')) { summary.stop_reason='authentication_failed'; break discovery; }
        } catch (e) {
          const item = {media_id:media.id,status:'failed',error:failure(e)};
          store.item(run,media.id,'failed',item); summary.items.push(item);
          if ([429].includes(item.error.http_status) || [4,17,32,613,80002].includes(item.error.meta_code)) { summary.stop_reason='rate_limited'; break discovery; }
          if (['authentication_failed','account_mismatch','not_configured'].includes(item.error.code)) { summary.stop_reason=item.error.code; break discovery; }
        }
      }
      if (!listing.pagination.has_next_page) { summary.discovery_complete=true; break; }
      after = listing.pagination.after;
      if (!after || cursors.has(after)) { summary.stop_reason='repeated_or_missing_cursor'; break; }
      cursors.add(after);
    }
    if (signal?.aborted) summary.stop_reason='interrupted';
    if (!summary.discovery_complete && !summary.stop_reason && !summary.discovery_error) summary.stop_reason='page_limit';
    summary.status = summary.stop_reason==='interrupted' ? 'interrupted' : summary.discovery_error || summary.items.some((m: Json)=>['failed','partial'].includes(m.status)) || ['rate_limited','authentication_failed','repeated_or_missing_cursor','account_mismatch','not_configured'].includes(summary.stop_reason) ? 'partial' : 'completed';
  } catch { summary.status='failed'; summary.stop_reason='internal_error'; }
  finally {
    summary.finished_at=new Date().toISOString();
    summary.counts=Object.fromEntries(['succeeded','partial','failed','skipped','interrupted'].map(status=>[status,summary.items.filter((item: Json)=>item.status===status).length]));
    store.finish(run,summary.status ?? 'failed',summary);
  }
  return summary;
}
if (import.meta.main) {
  let release: (()=>void) | undefined; let store: History | undefined;
  const controller = new AbortController(); const stop = () => controller.abort();
  process.on('SIGINT',stop); process.on('SIGTERM',stop);
  try {
    const {values} = parseArgs({options:{days:{type:'string'},pages:{type:'string'},'page-size':{type:'string'},reels:{type:'string'}},strict:true});
    const o = {days:Number(values.days ?? defaults.days),pages:Number(values.pages ?? defaults.pages),pageSize:Number(values['page-size'] ?? defaults.pageSize),reels:Number(values.reels ?? defaults.reels)};
    validateOptions(o); process.umask(0o077); release = writerLock(); store = new History(); store.recover();
    const result = await collect(store,undefined,o,controller.signal);
    console.log(JSON.stringify(result,null,2)); process.exitCode=result.status==='completed' ? 0 : result.status==='interrupted' ? 130 : 2;
  } catch (e) { console.error(JSON.stringify({error:failure(e)})); process.exitCode=e instanceof InstagramError && e.code==='collection_busy' ? 75 : 1; }
  finally { store?.close(); release?.(); process.off('SIGINT',stop); process.off('SIGTERM',stop); }
}
