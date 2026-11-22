import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { databasePath, History } from '../src/history.ts';
import { credentials, root, saveResponse } from '../src/core.ts';
import type { Json } from '../src/core.ts';

const store = new History(undefined,true);
const client = new Client({name:'instagram-history-verifier',version:'1.0.0'});
const transport = new StdioClientTransport({command:process.execPath,args:[root+'src/mcp.ts'],cwd:'/tmp',stderr:'pipe'});
try {
  assert.equal(store.db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  assert.equal(store.db.prepare('PRAGMA foreign_key_check').all().length,0);
  const live = store.db.prepare("SELECT * FROM collection_runs WHERE kind='collection' AND status='completed' ORDER BY started_at DESC LIMIT 1").get();
  assert.ok(live,'A completed real collection is required before verification.');
  const reel = store.db.prepare("SELECT m.id FROM media m JOIN metric_snapshots s ON m.id=s.media_id JOIN run_snapshots rs ON rs.snapshot_id=s.id JOIN collection_runs r ON r.id=rs.run_id GROUP BY m.id HAVING count(DISTINCT r.kind)=2 LIMIT 1").get();
  assert.ok(reel,'Need both imported and collected history for one reel.');
  const credential=await credentials();
  assert.ok(!readFileSync(databasePath).includes(Buffer.from(credential.access_token)),'Credential found in database');
  assert.equal(statSync(databasePath).mode & 0o777,0o600);
  assert.equal(statSync(root+'data').mode & 0o777,0o700);
  await client.connect(transport);
  const listed=await client.listTools(); assert.equal(listed.tools.length,5);assert.ok(listed.tools.every(t=>t.annotations?.readOnlyHint));
  async function call(name: string,args: Json): Promise<Json> {
    const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes(credential.access_token));return result.structuredContent as Json;
  }
  const history=await call('instagram_get_metric_history',{media_id:reel.id,limit:500});
  assert.ok(history.observations.length>9);
  const comparisons=[];
  for (const name of ['views','reach','ig_reels_avg_watch_time']) {
    const rows=history.observations.filter((s: Json)=>s.name===name && s.status==='available').sort((a: Json,b: Json)=>Date.parse(a.retrieved_at)-Date.parse(b.retrieved_at));
    assert.ok(rows.length>=2);
    const comparison=await call('instagram_compare_snapshots',{media_id:reel.id,from_snapshot_id:rows[0].id,to_snapshot_id:rows.at(-1).id});
    assert.ok(comparison.interval.seconds>0);
    if (name==='views') assert.equal(comparison.delta,rows.at(-1).value-rows[0].value);
    else assert.equal(comparison.delta,null);
    comparisons.push(comparison);
  }
  const status=await call('instagram_connection_status',{verify:false});
  const counts=Object.fromEntries(['accounts','media','collection_runs','metric_snapshots'].map(table=>[table,store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]));
  const proof={validation:'live_history_mcp_client_verified',checked_at:new Date().toISOString(),collection_run:live.id,tools:listed.tools.map(t=>t.name),counts,history,comparisons,credential_expiry:status.credential.expires_at};
  const path=await saveResponse(proof,credential.access_token);
  console.log(JSON.stringify({validation:proof.validation,checked_at:proof.checked_at,counts,collection_run:live.id,observations:history.observations.length,comparisons:comparisons.map(c=>({metric:c.from.name,interval:c.interval,delta:c.delta,reason:c.reason ?? c.interpretation})),credential_expiry:proof.credential_expiry,proof:path},null,2));
} finally {await client.close();store.close();}
