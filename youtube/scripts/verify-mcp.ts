import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from '../src/core.ts';

// Live check: launch the real stdio server, verify the channel, list uploads, read one video's stats.
const client = new Client({ name: 'verify', version: '1' });
const data = (r: any) => { if (r.isError) throw new Error(r.content[0].text); return r.structuredContent ?? JSON.parse(r.content[0].text); };
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [root + 'src/mcp.ts'], cwd: '/tmp', stderr: 'inherit' }));
  const tools = (await client.listTools()).tools.map(t => t.name);
  const status = data(await client.callTool({ name: 'youtube_status', arguments: {} }));
  if (status.health !== 'healthy') throw new Error(`Status ${status.health}`);
  const list = data(await client.callTool({ name: 'youtube_list_videos', arguments: { limit: 5 } }));
  const first = list.videos.find((v: any) => v.privacy === 'public') ?? list.videos[0];
  const stats = first ? data(await client.callTool({ name: 'youtube_video_stats', arguments: { video_id: first.id } })) : null;
  console.log(JSON.stringify({ verified_at: new Date().toISOString(), tools, channel: status.channel, uploads_listed: list.videos.length,
    sample: first ? { id: first.id, title: first.title, lifetime: stats.windows[0].metrics, traffic_sources: stats.traffic_sources.rows.slice(0, 5) } : null }, null, 2));
} catch (e) { console.error(e instanceof Error ? e.message : 'Verification failed.'); process.exitCode = 1; }
finally { await client.close(); }
