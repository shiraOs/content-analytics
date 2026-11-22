import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { History, writerLock, compare } from '../src/history.ts';
import { importDirectory, parseSaved } from '../src/import-history.ts';
import { collect, defaults } from '../src/collect.ts';
import type { Json } from '../src/core.ts';
const first = '2026-09-09T00:00:00.000Z';
const second = '2026-09-10T00:00:00.000Z';
const account = {user_id:'42',username:'creator.example'};
const media = {id:'1',media_product_type:'REELS',timestamp:'2026-09-07T00:00:00.000Z'};
const metric = (extra: Json = {})=>({name:'views',status:'available',value:10,period:'lifetime',unit:'count',retrieved_at:first,...extra});
const observation = (extra: Json = {})=>({account,media,api_version:'v25.0',metrics:[metric()],...extra});
function db(t: any) {
  const dir = mkdtempSync(join(tmpdir(),'instagram-history-')); const path = join(dir,'history.sqlite');
  const store = new History(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});}); return {store,dir,path};
}
test('imports CLI requests and MCP proof idempotently using actual retrieval times, preserving failures and zero',async t=> {
  const {store,dir} = db(t);
  const cli: Json = {schema_version:1,...observation(),retrieved_at:second,requests:[{endpoint:'1/insights',parameters:{metric:'views'},retrieved_at:first,http_status:200,api_version_returned:null,body:{data:[{name:'views',period:'lifetime',values:[{value:0}]}]}}]};
  cli.metrics.push(metric({name:'follows',unit:undefined,status:'unsupported',value:null,period:null,retrieved_at:undefined}));
  writeFileSync(join(dir,'a.json'),JSON.stringify(cli));
  writeFileSync(join(dir,'b.json'),JSON.stringify({validation:'live_mcp_client_verified',insights:observation({metrics:[metric({retrieved_at:second,status:'error',value:999,error:{code:4},http_status:429})]})}));
  writeFileSync(join(dir,'failed.json'),JSON.stringify({schema_version:1,validation:'incomplete',requests:[],metrics:[]}));
  writeFileSync(join(dir,'invalid.json'),'{broken');
  let r = await importDirectory(store,dir); assert.equal(r.imported,2); assert.equal(r.skipped,1); assert.equal(r.invalid,1);
  r = await importDirectory(store,dir); assert.equal(r.imported,0); assert.equal(r.duplicate,2);
  const rows = store.history('1').observations;
  assert.equal(rows.length,3); assert.equal(rows.find((r: Json)=>r.status==='available').retrieved_at,first);
  assert.equal(rows.find((r: Json)=>r.status==='available').value,0);
  assert.equal(rows.find((r: Json)=>r.status==='error').value,null);
  assert.equal(rows.find((r: Json)=>r.name==='follows').retrieved_at,null);
  assert.equal(store.history('1').media.publication_time,media.timestamp);
  // A renamed/reformatted copy is a different file digest but not new observations.
  writeFileSync(join(dir,'copy.json'),JSON.stringify(cli,null,2)); await importDirectory(store,dir);
  assert.equal(store.history('1').observations.length,3);
});
test('import rejects unknown timestamps, account mismatch, invalid units; transaction rollback is atomic',t=> {
  const {store} = db(t);
  for (const bad of [observation({metrics:[metric({retrieved_at:undefined})]}), observation({account:{...account,username:'other'}}),observation({metrics:[metric({unit:'seconds'})]})])
    assert.throws(()=>parseSaved({validation:'live_mcp_client_verified',insights:bad}));
  assert.throws(()=>store.transaction(()=>{const run=store.start('import');store.save(run,observation());throw new Error('interrupted');}));
  assert.equal(store.history('1').observations.length,0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM collection_runs').get()!.n,0);
});
test('comparison preserves downward revisions and actual intervals; never subtracts reach, averages or incompatible metrics',()=> {
  const a = {...metric(),account_id:'42',media_id:'1',meaning:'instagram.reels.views.v1',api_version:'v25.0'};
  const b = {...a,retrieved_at:second,value:7};
  assert.equal(compare(a,b).delta,-3); assert.equal(compare(a,b).interval.seconds,86400);
  for (const changed of [{unit:'milliseconds'},{period:null},{period:'day'},{api_version:'v26.0'},{meaning:'changed'},{status:'error'},{value:null},{value:'7'},{retrieved_at:first},{retrieved_at:undefined},{media_id:'2'},{details:{api_version_returned:'v26.0'}},{details:{description:'new meaning'}},{details:{values:[{value:1},{value:2}]}}]) assert.equal(compare(a,{...b,...changed}).delta,null);
  for (const name of ['reach','ig_reels_avg_watch_time']) assert.equal(compare({...a,name},{...b,name}).delta,null);
});
function service(mode = '') {
  const calls: string[]=[];
  return {calls,connectionStatus:async()=>({}), listRecentMedia:async (_limit?: number,after?: string)=>{
    if (after && mode==='page-error') throw new Error('do not persist raw secret');
    return {account,media:[{...media,id:after?'3':'1'},{...media,id:after?'4':'2'}],pagination:{has_next_page:!after,after:!after?'next':null}};
  },getReelInsights:async(id: string)=>{
    calls.push(id);
    return observation({media:{...media,id},metrics:[metric(),metric({name:'reach',status:'missing',value:null}),...(mode==='rate'?[metric({name:'likes',status:'error',http_status:429,error:{code:4},value:null})]:[])]});
  }};
}
test('partial metrics and page failure retain successful snapshots and per-item reports',async t=> {
  const {store}=db(t); const s=service('page-error'); const r=await collect(store,s,defaults,undefined,new Date(second));
  assert.equal(r.status,'partial'); assert.equal(r.pages,1); assert.equal(r.items.length,2); assert.equal(r.items[0].status,'partial');
  assert.deepEqual(s.calls,['1','2']); assert.equal(store.history('1').observations.length,2);
  assert.equal(store.history('1').observations.find((m: Json)=>m.name==='reach').value,null);
  assert.ok(!JSON.stringify(r).includes('secret'));
});
test('rate limiting stops subsequent reels without retry storms or discarding completed metrics',async t=> {
  const {store}=db(t);const s=service('rate');const r=await collect(store,s,defaults,undefined,new Date(second));
  assert.equal(r.stop_reason,'rate_limited'); assert.equal(r.status,'partial');assert.deepEqual(s.calls,['1']);assert.equal(store.history('1').observations.length,3);
});
test('bounded pagination deduplicates media, honors cutoff and configured cap without assuming chronological ordering',async t=> {
  const {store}=db(t);const s=service();
  s.listRecentMedia=async(_l,after)=>({account,media:after?[media,{...media,id:'2'}]:[{...media,id:'8',timestamp:'2020-01-01T00:00:00Z'},media],pagination:{has_next_page:!after,after:after?null:'next'}});
  let r=await collect(store,s,{...defaults,reels:1},undefined,new Date(second));
  assert.deepEqual(s.calls,['1']);assert.equal(r.stop_reason,'reel_limit');assert.equal(r.discovered,3);
  r=await collect(store,s,{...defaults,pages:1},undefined,new Date(second));assert.equal(r.stop_reason,'page_limit');assert.equal(r.discovery_complete,false);
});
test('graceful cancellation reports interrupted and does not call the API',async t=> {
  const {store}=db(t);const s=service();const c=new AbortController();c.abort();const r=await collect(store,s,defaults,c.signal,new Date(second));
  assert.equal(r.status,'interrupted');assert.equal(s.calls.length,0);
});
test('writer mutex rejects overlap, WAL permits readonly history, and stale runs recover without deleting observations',t=> {
  const {store,path}=db(t);const release=writerLock(path);
  try {assert.throws(()=>writerLock(path),/Another collection/);
    const run=store.start('collection');store.transaction(()=>{store.save(run,observation());store.item(run,'1','pending');});
    const reader=new History(path,true);try {assert.equal(reader.history('1').observations.length,1);assert.throws(()=>reader.start('collection'));}finally{reader.close();}
    store.recover();assert.equal(store.db.prepare('SELECT status FROM collection_runs WHERE id=?').get(run)!.status,'interrupted');
    assert.equal(store.db.prepare('SELECT status FROM run_items').get()!.status,'interrupted');assert.equal(store.history('1').observations.length,1);
    assert.equal(statSync(path).mode & 0o777,0o600);
  } finally {release();}
  writerLock(path)();
});
test('OS releases writer mutex after forced process termination',async t=> {
  const {path}=db(t);
  const child=spawn(process.execPath,['--input-type=module','-e',`import { DatabaseSync } from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN IMMEDIATE');console.log('locked');setInterval(()=>{},1000);`,path+'.lock'],{stdio:['ignore','pipe','pipe']});
  try {await once(child.stdout,'data');assert.throws(()=>writerLock(path));const ended=once(child,'exit');child.kill('SIGKILL');await ended;writerLock(path)();}
  finally {child.kill();}
});
test('history cursor handles equal instants, timezone offsets and unknown timestamps without dropping observations',t=> {
  const {store}=db(t); const run=store.start('test');
  store.save(run,observation({metrics:[metric(),metric({value:11,retrieved_at:'2026-09-09T03:00:00+0300'}),metric({value:12,retrieved_at:'2026-09-08T23:00:00Z'}),metric({status:'unsupported',value:null,retrieved_at:undefined})]}));
  const all=[];let cursor: string|undefined;
  do {const page=store.history('1',1,undefined,'views',cursor);all.push(...page.observations);cursor=page.next_cursor ?? undefined;}while(cursor);
  assert.equal(all.length,4);assert.equal(new Set(all.map(r=>r.id)).size,4);assert.equal(all[3].retrieved_at,null);
  assert.equal(Date.parse(all[0].retrieved_at),Date.parse(all[1].retrieved_at));
});
test('CLI import trusts failed request evidence over an incorrectly saved successful normalized value',()=> {
  const data=parseSaved({schema_version:1,...observation(),requests:[{endpoint:'1/insights',parameters:{metric:'views'},retrieved_at:first,http_status:429,body:{error:{code:4}}}]})!;
  assert.equal(data.metrics[0].status,'error');assert.equal(data.metrics[0].value,null);assert.equal(data.metrics[0].http_status,429);
});
