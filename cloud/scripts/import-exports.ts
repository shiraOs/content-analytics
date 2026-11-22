// The weekly step after downloading LinkedIn (and, optionally, TikTok Studio) analytics:
//   npm run import:exports            reads new files in ../linkedin/data/export and ../tiktok/data/export into the local
//                                     history, then copies the new rows to the cloud databases (D1) for the Sunday report
//   npm run import:exports -- --local same, into the `wrangler dev` copy instead of Cloudflare
// Only files the cloud doesn't have yet are sent (by file fingerprint), so running it twice is harmless.
// Export files themselves never leave your computer: only the numbers, post links and short post labels.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wrangler, databases, root } from './wrangler.ts';
import { literal } from './import-history.ts';
import { report } from '../../shared/import-run.ts';
import { importLinkedIn } from '../../linkedin/src/import.ts';
import { importTikTokExports } from '../../tiktok/src/import-export.ts';

const exportTables = ['export_files', 'export_items', 'export_values'] as const;

// SQL that adds the given files' rows (and refreshes every post/video's link, date and label) to D1.
export function dumpExports(path: string, skip: Set<string>): { sql: string; files: number; values: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const files = (db.prepare('SELECT * FROM export_files').all() as any[]).filter(f => !skip.has(f.digest));
    const lines: string[] = [];
    const insert = (t: string, row: Record<string, unknown>, tail = '') =>
      lines.push(`INSERT ${tail ? '' : 'OR IGNORE '}INTO ${t} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(literal).join(',')})${tail};`);
    for (const f of files) insert('export_files', f);
    // Items point at the file that last named them; a file the cloud already has is fine as a reference.
    for (const i of db.prepare('SELECT * FROM export_items').all() as any[])
      insert('export_items', i, ' ON CONFLICT(id) DO UPDATE SET url=COALESCE(excluded.url,export_items.url),published_at=COALESCE(excluded.published_at,export_items.published_at),title_start=COALESCE(excluded.title_start,export_items.title_start),metadata_json=excluded.metadata_json,last_file=excluded.last_file');
    let values = 0;
    const byFile = db.prepare('SELECT * FROM export_values WHERE file_digest=?');
    for (const f of files) for (const v of byFile.all(f.digest) as any[]) { insert('export_values', v); values++; }
    return { sql: files.length ? lines.join('\n') + '\n' : '', files: files.length, values };
  } finally { db.close(); }
}

async function cloudDigests(name: string, where: string): Promise<Set<string>> {
  const r = await wrangler(['d1', 'execute', name, where, '--command', 'SELECT digest FROM export_files', '--json']);
  if (r.code !== 0) throw new Error(`Could not read ${name}: ${r.err.trim().split('\n').slice(-3).join(' ')}`);
  return new Set((JSON.parse(r.out)[0]?.results ?? []).map((x: any) => x.digest));
}

if (import.meta.main) {
  let dir: string | undefined;
  try {
    const where = process.argv.includes('--local') ? '--local' : '--remote';
    console.log(report('LinkedIn', importLinkedIn()));
    console.log(report('TikTok Studio', importTikTokExports()));
    dir = mkdtempSync(tmpdir() + '/content-exports-');
    for (const platform of ['linkedin', 'tiktok'] as const) {
      const path = root + `../${platform}/data/history.sqlite`;
      if (!existsSync(path)) { console.log(`${platform}: nothing imported on this computer yet`); continue; }
      const name = databases[platform];
      const schema = await wrangler(['d1', 'execute', name, where, '--file', `schema/${platform}.sql`, '-y']);
      if (schema.code !== 0) throw new Error(`${name}: could not prepare tables: ${schema.err.trim().split('\n').slice(-3).join(' ')}`);
      const { sql, files, values } = dumpExports(path, await cloudDigests(name, where));
      if (!files) { console.log(`${platform}: cloud already up to date`); continue; }
      const file = `${dir}/${platform}.sql`;
      writeFileSync(file, sql, { mode: 0o600 });
      const r = await wrangler(['d1', 'execute', name, where, '--file', file, '-y']);
      console.log(`${platform}: ${r.code === 0 ? `sent to the cloud (${files} file(s), ${values} numbers)` : 'FAILED to send'}`);
      if (r.code !== 0) { console.error(r.err.trim().split('\n').slice(-6).join('\n')); process.exitCode = 1; }
    }
  } catch (e) { console.error(e instanceof Error ? e.message : 'Import failed.'); process.exitCode = 1; }
  finally { if (dir) rmSync(dir, { recursive: true, force: true }); }
}
