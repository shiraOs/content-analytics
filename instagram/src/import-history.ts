import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { credentials, metrics, normalize, root } from './core.ts';
import { History, writerLock, validTime, unit } from './history.ts';
import type { Json } from './core.ts';
import { sanitize, expectedUsername } from './service.ts';

const timestamp = z.string().refine(validTime);
const schema = z.object({
  account:z.object({user_id:z.union([z.string().regex(/^\d+$/),z.number().int().positive()]),username:z.literal(expectedUsername)}),
  media:z.object({id:z.string().regex(/^\d+$/),timestamp,media_product_type:z.literal('REELS'),media_type:z.string().nullable().optional(),caption:z.string().nullable().optional(),permalink:z.string().nullable().optional()}),
  api_version:z.string().regex(/^v\d+\.\d+$/),
  metrics:z.array(z.object({name:z.string().refine(name=>[...metrics,'follows'].includes(name)),
    status:z.enum(['available','missing','unsupported','permission_denied','authentication_failed','error']),
    value:z.unknown().optional(), period:z.string().nullable(), retrieved_at:timestamp.optional(),
    unit:z.string().nullable().optional(),unit_source:z.string().optional(),http_status:z.number().nullable().optional(),
    api_version_returned:z.string().nullable().optional(),title:z.string().nullable().optional(),description:z.string().nullable().optional(),
    values:z.unknown().optional(),total_value:z.unknown().optional(),error:z.unknown().optional(),reason:z.string().optional()
  }).refine(m=>m.status !== 'available' || (m.value !== undefined && m.value !== null && !!m.retrieved_at)))
});
export function parseSaved(input: Json): Json | null {
  let candidate: Json;
  if (input.validation === 'live_mcp_client_verified') candidate = input.insights;
  else if (input.schema_version === 1 && input.account && input.media && Array.isArray(input.requests)) {
    // Re-normalize the actual saved requests, rather than trusting a success label.
    const normalized = [];
    for (const name of metrics) {
      const r = input.requests.find((r: Json)=>r.endpoint === `${input.media.id}/insights` && r.parameters?.metric === name);
      if (!r) continue;
      if (!validTime(r.retrieved_at) || !r.body || !('http_status' in r)) throw new Error('invalid saved request');
      normalized.push({...normalize(name,r), unit:unit(name),unit_source:'Existing integration native metric definition',http_status:r.http_status,api_version_returned:r.api_version_returned ?? null});
    }
    for (const m of input.metrics ?? []) if (m.name === 'follows' && m.status === 'unsupported') normalized.push(m);
    candidate = {...input,metrics:normalized};
  } else return null;
  const parsed = schema.parse(candidate);
  if (!parsed.metrics.some(m=>m.retrieved_at)) return null;
  if (new Set(parsed.metrics.map(m=>m.name)).size !== parsed.metrics.length) throw new Error('duplicate metrics');
  for (const m of parsed.metrics) if (m.unit !== undefined && m.unit !== null && m.unit !== unit(m.name)) throw new Error('unexpected units');
  return parsed;
}
export async function importDirectory(store: History, directory = root+'data', token = '') {
  const summary: Json = { imported:0,duplicate:0,skipped:0,invalid:0,files:[] };
  for (const file of (await readdir(directory)).filter(f=>f.endsWith('.json')).sort()) {
    try {
      const raw = await readFile(join(directory,file),'utf8');
      const digest = createHash('sha256').update(raw).digest('hex');
      if (store.db.prepare('SELECT 1 FROM imports WHERE digest=?').get(digest)) { summary.duplicate++; continue; }
      const parsed = parseSaved(sanitize(JSON.parse(raw),token));
      if (!parsed) { summary.skipped++; continue; }
      store.transaction(()=> {
        const run = store.start('import',{source_digest:digest});
        store.save(run,parsed);
        store.item(run,parsed.media.id,'imported');
        store.db.prepare('INSERT INTO imports VALUES (?,?)').run(digest,run);
        store.finish(run,'completed',{source_digest:digest,observation_times:'Original recorded metric timestamps; no file mtime or import-time substitution.'});
      });
      summary.imported++;
      summary.files.push({file,status:'imported'});
    } catch { summary.invalid++; summary.files.push({file,status:'invalid',reason:'Unrecognized or invalid historical data; not imported.'}); }
  }
  return summary;
}
if (import.meta.main) {
  let release: (()=>void) | undefined; let store: History | undefined;
  try {
    if (process.argv.length > 2) throw new Error('No arguments accepted. Imports the integration data directory.');
    process.umask(0o077); release = writerLock(); store = new History(); store.recover();
    const c = await credentials();
    const summary = await importDirectory(store,undefined,c.access_token);
    console.log(JSON.stringify(summary,null,2)); if (summary.invalid) process.exitCode = 2;
  } catch { console.error('History import failed; verify credentials, database availability and no overlapping writer.'); process.exitCode = 1; }
  finally { store?.close(); release?.(); }
}
