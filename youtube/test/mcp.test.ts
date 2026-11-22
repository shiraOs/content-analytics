import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServer } from '../src/mcp.ts';
import { root } from '../src/core.ts';
import { fixture, secret } from './fixture.ts';

async function withClient(mode: string, action: (c: Client, calls: any[]) => Promise<void>) {
  const { service, calls } = fixture(mode); const server = createServer(service);
  const [ct, st] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  await server.connect(st); await client.connect(ct);
  try { await action(client, calls); } finally { await client.close(); await server.close(); }
}
const data = (r: any) => r.structuredContent ?? JSON.parse(r.content[0].text);
test('real stdio client lists exactly five read-only tools', async () => {
  const client = new Client({ name: 'stdio-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [root + 'src/mcp.ts'], cwd: '/tmp', stderr: 'pipe' });
  try { await client.connect(transport); const list = await client.listTools(); assert.equal(list.tools.length, 5); assert.ok(list.tools.every(t => t.annotations?.readOnlyHint)); }
  finally { await client.close(); }
});
test('list videos and video stats work; unowned video refused; no token leaks', () => withClient('', async (c, calls) => {
  const list = data(await c.callTool({ name: 'youtube_list_videos', arguments: { limit: 10 } }));
  assert.equal(list.videos.length, 3); assert.ok(!JSON.stringify(list).includes(secret));
  const stats = data(await c.callTool({ name: 'youtube_video_stats', arguments: { video_id: 'AAAAAAAAAAA' } }));
  assert.equal(stats.windows.length, 2); assert.equal(stats.traffic_sources.rows[0].insightTrafficSourceType, 'YT_SEARCH');
  const before = calls.length;
  const bad = await c.callTool({ name: 'youtube_video_stats', arguments: { video_id: 'ZZZZZZZZZZZ' } });
  assert.equal(bad.isError, true); assert.equal(data(bad).error.code, 'ownership_not_verified');
  assert.ok(!calls.slice(before).some(x => x.endpoint === 'reports'));
}));
test('bad input rejected before any API call; auth failure is sanitized', async () => {
  await withClient('', async (c, calls) => {
    for (const args of [{ video_id: 'short' }, { video_id: 'https://evil/?access_token=x' }]) {
      try { const r = await c.callTool({ name: 'youtube_video_stats', arguments: args }); assert.equal(r.isError, true); }
      catch (e) { assert.match(String(e), /valid|schema|pattern/i); }
    }
    assert.equal(calls.length, 0);
  });
  await withClient('auth', async c => {
    const r = await c.callTool({ name: 'youtube_list_videos', arguments: {} });
    assert.equal(r.isError, true); assert.equal(data(r).error.code, 'authentication_failed'); assert.ok(!JSON.stringify(r).includes(secret));
  });
  await withClient('', async c => { const s = data(await c.callTool({ name: 'youtube_status', arguments: { verify: false } })); assert.equal(s.health, 'not_checked'); });
});
