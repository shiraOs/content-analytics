import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from '../src/mcp.ts';
import { createInstagramService, sanitize } from '../src/service.ts';
import { root } from '../src/core.ts';
import type { Json, Result } from '../src/core.ts';
const token = 'synthetic-private-token';
const result = (body: Json, http_status = 200): Result => ({body, http_status, retrieved_at: '2026-09-09T00:00:00Z', endpoint:'test', parameters:{}, api_version_returned:null});
function fixture(mode = '') {
  const calls: string[] = [];
  const service = createInstagramService({ credentials: async () => {
    if (mode === 'absent') throw new Error(token);
    return { access_token: token, expires_at: null };
  }, request: async (_token, endpoint, params) => {
    calls.push(endpoint);
    if (mode === 'throw') throw new Error(token);
    if (mode === 'auth') return result({ error: { code:190, message: token } },400);
    if (endpoint === 'me') return result({ user_id:'42', username:mode === 'mismatch' ? 'other' : 'creator.example' });
    if (endpoint === '42/media') return result({ data:[{id:params?.after ? '2':'1', media_product_type:mode === 'image' ? 'FEED':'REELS', caption:token, permalink:'https://www.instagram.com/reel/x/?access_token='+token}], paging:params?.after ? {} : { next:'https://graph.instagram.com/?access_token='+token,cursors:{after:'cursor'} } });
    const name = params?.metric;
    if (name === 'reach') return result({data:[]});
    if (name === 'likes') return result({error:{code:100,message:'Unsupported metric '+token}},400);
    if (name === 'comments') return result({error:{code:190,message:token}},400);
    if (name === 'shares') return result({error:{message:'Network failed '+token}},500);
    return result({data:[{name,period:'lifetime',values:[{value:0}]}]});
  } });
  return {service,calls};
}
async function withClient(mode: string, action: (c: Client, calls: string[]) => Promise<void>) {
  const {service,calls} = fixture(mode); const server = createServer(service);
  const [ct,st] = InMemoryTransport.createLinkedPair(); const client = new Client({name:'test',version:'1'});
  await server.connect(st); await client.connect(ct);
  try { await action(client,calls); } finally { await client.close(); await server.close(); }
}
const data = (r: any) => r.structuredContent ?? JSON.parse(r.content[0].text);
test('real stdio client initializes and lists exactly five read-only tools without API access', async () => {
  const client = new Client({name:'stdio-test',version:'1'});
  const transport = new StdioClientTransport({ command:process.execPath,args:[root+'src/mcp.ts'],cwd:'/tmp',stderr:'pipe' });
  try { await client.connect(transport); const list = await client.listTools(); assert.equal(list.tools.length,5); assert.ok(list.tools.every(t=>t.annotations?.readOnlyHint)); }
  finally { await client.close(); }
});
test('MCP validates bounds and cursors before API calls', () => withClient('', async (c,calls) => {
  for (const args of [{limit:0},{limit:51},{limit:1.5},{after:'https://evil.invalid/?access_token=x'}]) {
    try { const r = await c.callTool({name:'instagram_list_recent_media',arguments:args}); assert.equal(r.isError,true); }
    catch(e) { assert.match(String(e), /valid|schema|limit|pattern/i); }
  }
  assert.equal(calls.length,0);
}));
test('pagination strips URLs and credentials; metrics preserve zero, missing, unsupported and errors', () => withClient('',async c => {
  const first = data(await c.callTool({name:'instagram_list_recent_media',arguments:{limit:1}}));
  assert.equal(first.pagination.after,'cursor'); assert.ok(!JSON.stringify(first).includes(token)); assert.ok(!JSON.stringify(first).includes('access_token'));
  const next = data(await c.callTool({name:'instagram_list_recent_media',arguments:{after:first.pagination.after}})); assert.equal(next.media[0].id,'2');
  const insights = data(await c.callTool({name:'instagram_get_reel_insights',arguments:{media_id:'2'}}));
  assert.deepEqual(insights.metrics.slice(0,6).map((m: Json)=>m.status),['available','missing','unsupported','authentication_failed','available','error']);
  assert.equal(insights.metrics[0].value,0); assert.equal(insights.metrics[0].period,'lifetime'); assert.equal(insights.metrics[6].unit,'milliseconds');
  assert.ok(insights.metrics.every((m: Json)=>m.retrieved_at)); assert.ok(!JSON.stringify(insights).includes(token));
}));
test('local configuration is separate from live verification and expiry remains unknown', async () => {
  const {service,calls} = fixture(); const local = await service.connectionStatus(false);
  assert.equal(local.connection_verified,false); assert.equal(local.credentials_configured,true); assert.equal(local.credential.expires_at,null); assert.equal(calls.length,0);
  assert.equal((await service.connectionStatus()).connection_verified,true);
  assert.equal((await fixture('auth').service.connectionStatus()).health,'authentication_failed');
  assert.equal((await fixture('absent').service.connectionStatus()).credentials_configured,false);
});
test('wrong account and non-reels are blocked; unexpected failures are sanitized', async () => {
  for (const [mode,name,args,code] of [
    ['mismatch','instagram_list_recent_media',{},'account_mismatch'],
    ['image','instagram_get_reel_insights',{media_id:'1'},'not_a_reel'],
    ['','instagram_get_reel_insights',{media_id:'999'},'ownership_not_verified'],
    ['throw','instagram_list_recent_media',{},'internal_error'],
    ['auth','instagram_list_recent_media',{},'authentication_failed']
  ] as const) await withClient(mode,async (c,calls) => {
    const r = await c.callTool({name,arguments:args}); assert.equal(r.isError,true); assert.equal(data(r).error.code,code); assert.ok(!JSON.stringify(r).includes(token)); assert.ok(!calls.some(p=>p.endsWith('/insights')));
  });
});
test('token-bearing URLs removed even in nested descriptions',()=> {
  assert.equal(sanitize({description:'See https://x.invalid/?access_token=hidden&after=x'}).description,'See [credential URL removed]');
});
