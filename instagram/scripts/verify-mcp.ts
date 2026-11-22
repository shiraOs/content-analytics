import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root, credentials, saveResponse } from '../src/core.ts';

const client = new Client({ name: 'instagram-live-verifier', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [root + 'src/mcp.ts'], cwd: '/tmp', stderr: 'pipe' });
let diagnostics = '';
transport.stderr?.on('data', chunk => { diagnostics += String(chunk); });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(t => t.name).sort(), ['instagram_compare_snapshots','instagram_connection_status','instagram_get_metric_history','instagram_get_reel_insights','instagram_list_recent_media']);
  const c = await credentials();
  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args }, { timeout: 180000 });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(c.access_token), 'Credential appeared in tool result');
    assert.ok(!/https?:[^\s]*access_token/i.test(serialized), 'Credential URL appeared in tool result');
    assert.ok(!result.isError, `Tool ${name} failed: ${serialized}`);
    return result.structuredContent as Record<string, any>;
  }
  const local = await call('instagram_connection_status', { verify: false });
  assert.equal(local.credentials_configured, true); assert.equal(local.connection_verified, false);
  const connection = await call('instagram_connection_status', {});
  assert.equal(connection.connection_verified, true, JSON.stringify(connection));
  const listing = await call('instagram_list_recent_media', { limit: 10 });
  assert.ok(listing.media.length > 0 && listing.media.length <= 10);
  let paginationVerified = false;
  if (listing.pagination.has_next_page) {
    const next = await call('instagram_list_recent_media', { limit: 2, after: listing.pagination.after });
    assert.ok(next.media.length > 0 && next.media.length <= 2);
    assert.ok(!listing.media.some((m: any) => m.id === next.media[0].id)); paginationVerified = true;
  }
  const reel = listing.media.filter((m: any) => m.media_product_type === 'REELS').sort((a: any,b: any) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  assert.ok(reel, 'No reel in first ten posts; inspect listing and expand verification.');
  const insights = await call('instagram_get_reel_insights', { media_id: reel.id });
  assert.ok(insights.metrics.some((m: any) => m.status === 'available'));
  const failure = await client.callTool({ name: 'instagram_get_reel_insights', arguments: { media_id: '0' } }, { timeout: 180000 });
  assert.equal(failure.isError, true);
  assert.ok(JSON.stringify(failure).includes('ownership_not_verified'));
  assert.ok(!JSON.stringify(failure).includes(c.access_token));
  const proof = { validation: 'live_mcp_client_verified', checked_at: new Date().toISOString(), tools: tools.tools.map(t => t.name), pagination_verified: paginationVerified, connection, listing, insights, sanitized_failure: failure };
  const path = await saveResponse(proof, c.access_token);
  assert.ok(!diagnostics.includes(c.access_token));
  console.log(JSON.stringify({ validation: proof.validation, checked_at: proof.checked_at, tools: proof.tools, pagination_verified: paginationVerified, account: connection.account.username, reel_id: reel.id, metrics: insights.metrics.map((m: any) => ({ name:m.name, status:m.status,value:m.value,unit:m.unit,period:m.period })), proof: path }, null, 2));
} finally { await client.close(); }
