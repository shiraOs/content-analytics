// Copies the local three history.sqlite files into D1 so week-over-week change keeps working.
//   npm run import:history -- --local    into the `wrangler dev` copy
//   npm run import:history -- --remote   into the real databases
// Safe to repeat: rows already there are kept (finished runs get their final status). No API calls,
// and no credentials are involved — the history files never held any.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wrangler, databases, target, root } from './wrangler.ts';
import type { Platform } from './wrangler.ts';

// Parents before children, so D1's foreign keys hold.
const tables: Record<Platform, string[]> = {
  youtube: ['channels', 'videos', 'collection_runs', 'snapshots', 'run_snapshots'],
  instagram: ['accounts', 'media', 'collection_runs', 'run_items', 'metric_snapshots', 'run_snapshots', 'imports'],
  tiktok: ['accounts', 'videos', 'collection_runs', 'snapshots', 'run_snapshots'],
  // LinkedIn has only imported downloads; those (and TikTok Studio's) go up with npm run import:exports.
  linkedin: [],
  // The site database starts empty in the cloud; there is no local history to copy.
  site: []
};
// Rows the local collector updates after inserting them; everything else is immutable.
const upserts: Record<string, string> = {
  collection_runs: 'ON CONFLICT(id) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,details_json=excluded.details_json',
  run_items: 'ON CONFLICT(run_id,media_id) DO UPDATE SET status=excluded.status,details_json=excluded.details_json',
  videos: 'ON CONFLICT(id) DO UPDATE SET published_at=COALESCE(excluded.published_at,videos.published_at),metadata_json=excluded.metadata_json',
  media: 'ON CONFLICT(id) DO UPDATE SET publication_time=COALESCE(excluded.publication_time,media.publication_time),metadata_json=excluded.metadata_json'
};
export const literal = (v: unknown) => v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).split("'").join("''")}'`;

export function dump(path: string, platform: Platform): { sql: string; counts: Record<string, number> } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const lines: string[] = []; const counts: Record<string, number> = {};
    for (const t of tables[platform]) {
      const rows = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
      counts[t] = rows.length;
      for (const row of rows) {
        const cols = Object.keys(row);
        lines.push(`INSERT ${upserts[t] ? '' : 'OR IGNORE '}INTO ${t} (${cols.join(',')}) VALUES (${cols.map(c => literal(row[c])).join(',')})${upserts[t] ? ' ' + upserts[t] : ''};`);
      }
    }
    return { sql: lines.join('\n') + '\n', counts };
  } finally { db.close(); }
}

if (import.meta.main) {
  let dir: string | undefined;
  try {
    const where = target(process.argv);
    const only = process.argv.slice(2).filter(a => !a.startsWith('-')) as Platform[];
    dir = mkdtempSync(tmpdir() + '/content-import-');
    for (const platform of Object.keys(databases) as Platform[]) {
      if (only.length && !only.includes(platform)) continue;
      if (!tables[platform].length) continue;
      const path = root + `../${platform}/data/history.sqlite`;
      if (!existsSync(path)) { console.log(`${platform}: no local history, skipped`); continue; }
      const { sql, counts } = dump(path, platform);
      const file = `${dir}/${platform}.sql`;
      writeFileSync(file, sql, { mode: 0o600 });
      const r = await wrangler(['d1', 'execute', databases[platform], where, '--file', file, '-y']);
      console.log(`${platform}: ${r.code === 0 ? 'imported' : 'FAILED'} (${Object.entries(counts).map(([t, n]) => `${t} ${n}`).join(', ')})`);
      if (r.code !== 0) { console.error(r.err.trim().split('\n').slice(-6).join('\n')); process.exitCode = 1; }
    }
  } catch (e) { console.error(e instanceof Error ? e.message : 'Import failed.'); process.exitCode = 1; }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
