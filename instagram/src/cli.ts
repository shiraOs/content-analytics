import { credentials, metrics, normalize, request, saveResponse, status, version } from './core.ts';
import type { Json, Result } from './core.ts';
import { expectedUsername } from './service.ts';

async function main() {
  const args = process.argv.slice(2);
  const listOnly = args[0] === '--list' && args.length === 1;
  const selectedId = args[0] === '--media-id' && args.length === 2 && /^\d+$/.test(args[1]) ? args[1] : null;
  if (args.length && !listOnly && !selectedId) throw new Error('Usage: npm run fetch -- [--list | --media-id NUMERIC_ID]');
  const c = await credentials();
  const token = c.access_token;
  const output: Json = { schema_version: 1, started_at: new Date().toISOString(), retrieved_at: null,
    api_version: version, host: 'graph.instagram.com', login_flow: 'instagram', expected_username: expectedUsername,
    validation: 'incomplete', media_id: null, publication_time: null, metrics: [], requests: [] };
  const call = async (endpoint: string, parameters: Json = {}): Promise<Result> => {
    const response = await request(token, endpoint, parameters);
    output.requests.push(response); return response;
  };
  try {
    if (!expectedUsername) throw new Error('Set INSTAGRAM_USERNAME to the Instagram account you sign in with.');
    const identity = await call('me', { fields: 'user_id,username,account_type' });
    if (status(identity) !== 'available') throw new Error(`Account request: ${status(identity)}. See saved response for Meta error.`);
    const account = identity.body.data?.[0] ?? identity.body;
    if (account.username?.toLowerCase() !== expectedUsername) throw new Error(`Token does not identify ${expectedUsername}; stopped before retrieving media.`);
    if (!/^\d+$/.test(String(account.user_id))) throw new Error('Meta did not return a valid Instagram user_id.');
    output.account = account;
    const permissions = await call('me/permissions');
    output.permissions = { status: status(permissions), response: permissions.body };
    // Permission introspection may itself be unavailable; actual endpoint results remain the evidence.
    const media: Json[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const response = await call(`${account.user_id}/media`, {
        fields: 'id,caption,media_type,media_product_type,permalink,timestamp', limit: 25, ...(after ? { after } : {}) });
      if (status(response) !== 'available') throw new Error(`Media request: ${status(response)}. See saved response.`);
      if (!Array.isArray(response.body.data)) throw new Error('Meta media response did not contain a data array.');
      media.push(...response.body.data);
      output.recent_media = media;
      if (listOnly || media.some(m => selectedId ? m.id === selectedId : m.media_product_type === 'REELS')) break;
      after = response.body.paging?.cursors?.after;
      if (!response.body.paging?.next || !after) break;
    }
    const reels = media.filter(m => m.media_product_type === 'REELS')
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    console.log(`Authenticated as @${account.username} (${account.account_type ?? 'account type unavailable'}).`);
    console.table(media.map(m => ({ id: m.id, type: m.media_product_type, published: m.timestamp,
      caption: String(m.caption ?? '').replace(/[\r\n\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 70) })));
    if (listOnly) { output.validation = 'authenticated_media_listing_only'; return; }
    const reel = selectedId ? reels.find(m => m.id === selectedId) : reels[0];
    if (!reel) throw new Error('No matching owned REELS media found in up to 125 recent items. Use --list to inspect recent media.');
    output.media_id = reel.id;
    output.publication_time = reel.timestamp ?? null;
    output.media = reel;
    for (const name of metrics) {
      const result = await call(`${reel.id}/insights`, { metric: name, period: 'lifetime' });
      output.metrics.push(normalize(name, result));
    }
    output.metrics.push({ name: 'follows', status: 'unsupported', value: null, period: null,
      reason: 'Meta media insights reference lists follows for FEED and STORY, not REELS; not requested.',
      source: 'https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights' });
    const available = output.metrics.filter((m: Json) => m.status === 'available');
    output.validation = available.length ? 'authenticated_reel_and_insights' : 'authenticated_reel_without_available_insights';
    console.log(`\nReel ${reel.id} | Published ${reel.timestamp}\n${reel.permalink ?? ''}`);
    console.table(output.metrics.map((m: Json) => ({ metric: m.name, value: m.value ?? '—', status: m.status, period: m.period ?? '—' })));
    if (!available.length) process.exitCode = 2;
  } catch (e) {
    output.failure = e instanceof Error ? e.message : 'Retrieval failed';
    console.error(output.failure); process.exitCode = 1;
  } finally {
    output.retrieved_at = new Date().toISOString();
    const path = await saveResponse(output, token);
    console.log(`Saved: ${path}\nValidation: ${output.validation}`);
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : 'Failed.'); process.exitCode = 1; });
