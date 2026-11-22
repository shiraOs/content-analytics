// Imports every new file in <platform>/data/export into that platform's data/history.sqlite, then moves it
// to data/export/imported/<today>/ so the folder is empty for next time. The same file (same bytes) is never
// counted twice. Files are only read, never opened by another program and never committed (data/ is git-ignored).
import { readdirSync, statSync, renameSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { openStore, alreadyImported, save, sha256 } from './export-store.ts';
import type { Parsed } from './export-store.ts';

export type FileResult = { file: string; status: 'imported' | 'duplicate' | 'skipped' | 'failed'; message: string; kind?: string; range?: [string | null, string | null] };
type Parse = (path: string) => Parsed | { skipped: string };

export function exportFiles(dir: string): string[] {
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names.sort()) {
    if (name.startsWith('.') || name === 'imported' || name === '__MACOSX') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...exportFiles(p));
    else if (/\.(xlsx|csv|zip)$/i.test(name)) out.push(p);
  }
  return out;
}

export function importFolder(opts: { root: string; parse: Parse; maxAgeDays?: number; at?: Date; move?: boolean }): FileResult[] {
  const at = opts.at ?? new Date();
  const exportDir = join(opts.root, 'data/export');
  const files = exportFiles(exportDir);
  if (!files.length) return [];
  const db = openStore(join(opts.root, 'data/history.sqlite'));
  const results: FileResult[] = [];
  const done: string[] = [];
  try {
    for (const path of files) {
      const file = relative(exportDir, path);
      try {
        if (opts.maxAgeDays && at.getTime() - statSync(path).mtime.getTime() > opts.maxAgeDays * 86400000) {
          results.push({ file, status: 'failed', message: `older than ${opts.maxAgeDays} days; download it again so the dates can be read correctly` });
          continue;
        }
        const digest = sha256(readFileSync(path));
        if (alreadyImported(db, digest)) { results.push({ file, status: 'duplicate', message: 'already imported earlier' }); done.push(path); continue; }
        const parsed = opts.parse(path);
        if ('skipped' in parsed) { results.push({ file, status: 'skipped', message: parsed.skipped }); done.push(path); continue; }
        const r = save(db, digest, parsed, at.toISOString());
        results.push({ file, status: 'imported', kind: parsed.file_kind, range: [parsed.range_start, parsed.range_end],
          message: `${r.values} numbers (${r.missing} empty cells kept as missing), ${r.items} posts/videos${parsed.notes.length ? '; ' + parsed.notes.join(' ') : ''}` });
        done.push(path);
      } catch (e: any) {
        results.push({ file, status: 'failed', message: `${e?.code ? e.code + ': ' : ''}${e instanceof Error ? e.message : 'could not read the file'}` });
      }
    }
  } finally { db.close(); }
  if (opts.move !== false) {
    const dest = join(exportDir, 'imported', at.toISOString().slice(0, 10));
    for (const path of done) {
      const target = join(dest, relative(exportDir, path));
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      renameSync(path, target);
      // Remove sub-folders the download came in (e.g. Followers_your.handle/) once they are empty.
      for (let d = dirname(path); d !== exportDir && d.startsWith(exportDir); d = dirname(d)) {
        try { if (readdirSync(d).every(n => n === '.DS_Store')) rmSync(d, { recursive: true }); else break; } catch { break; }
      }
    }
  }
  return results;
}

export function report(platform: string, results: FileResult[]): string {
  if (!results.length) return `${platform}: no new files in data/export.`;
  return results.map(r => `${platform}: ${r.file} — ${r.status}${r.range ? ` (${r.range[0]} to ${r.range[1]})` : ''}: ${r.message}`).join('\n');
}
