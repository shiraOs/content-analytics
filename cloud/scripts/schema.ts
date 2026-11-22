// Creates the tables in the three D1 databases (safe to repeat: CREATE … IF NOT EXISTS).
//   npm run schema -- --local    the copy `wrangler dev` uses on this computer
//   npm run schema -- --remote   the real databases on Cloudflare
import { wrangler, databases, target } from './wrangler.ts';

try {
  const where = target(process.argv);
  for (const [platform, name] of Object.entries(databases)) {
    const r = await wrangler(['d1', 'execute', name, where, '--file', `schema/${platform}.sql`, '-y']);
    console.log(`${name}: ${r.code === 0 ? 'tables ready' : 'failed'}`);
    if (r.code !== 0) { console.error(r.err.trim().split('\n').slice(-5).join('\n')); process.exitCode = 1; }
  }
} catch (e) { console.error(e instanceof Error ? e.message : 'Schema setup failed.'); process.exitCode = 1; }
