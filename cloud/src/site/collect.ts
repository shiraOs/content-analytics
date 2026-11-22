// The site's Sunday collection, in pieces (Workers Free allows 50 outside calls per invocation):
//   traffic  → Cloudflare Web Analytics + Bing             (≈5 calls)
//   google   → Search Console + GA4                        (≈11 calls)
//   index    → sitemap URLs, then URL Inspection, 40 per piece
// One collection run per week; each piece commits its own rows, so a later failure keeps earlier numbers.
// No retries on quota, permission or sign-in errors; a failed piece is recorded and the run goes on.
import { cloudflare, bing, google, sitemapUrls, inspect, windows, errorInfo } from './sources.ts';
import type { Row, SiteDeps, Windows } from './sources.ts';
import { hash, now, commit } from '../shared.ts';
import type { D1Database, Json } from '../shared.ts';

export const INSPECT_PER_PIECE = 40;
export const MAX_URLS = 200;

export class SiteStore {
  db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  async recover() { await this.db.prepare("UPDATE collection_runs SET status='interrupted', finished_at=? WHERE status='running'").bind(now()).run(); }
  async start(at: Date, details: Json) {
    const id = crypto.randomUUID();
    await this.db.prepare('INSERT INTO collection_runs VALUES (?,?,?,NULL,?,?)').bind(id, 'site', at.toISOString(), 'running', JSON.stringify(details)).run();
    return id;
  }
  async finish(id: string, status: string, details: Json) {
    await this.db.prepare('UPDATE collection_runs SET finished_at=?,status=?,details_json=? WHERE id=?').bind(now(), status, JSON.stringify(details), id).run();
  }
  async save(run: string, w: Windows, rows: Row[]) {
    const at = now();
    const out = [];
    for (const r of rows) {
      const win = r.window === 'now' ? null : (['cloudflare', 'google_analytics'].includes(r.source) ? w.traffic : w.search)[r.window];
      const record = { run, source: r.source, window: r.window, from: win?.from ?? null, to: win?.to ?? null, dimension: r.dimension, key: r.key, metric: r.metric };
      out.push(this.db.prepare('INSERT OR REPLACE INTO site_values VALUES (?,?,?,?,?,?,?,?,?,?,?)').bind(await hash(record), run, r.source, r.window,
        record.from, record.to, r.dimension, r.key, r.metric, JSON.stringify(r.value ?? null), at));
    }
    await commit(this.db, out);
  }
}

// One piece. `state` is this week's progress (stored in cloud_jobs.state_json).
export async function sitePiece(store: SiteStore, deps: SiteDeps, state: Json, at: Date): Promise<{ state: Json; done: boolean; action: string }> {
  const w = windows(at);
  if (!state.run_id) {
    await store.recover();
    state = { run_id: await store.start(at, { windows: w, host: 'cloudflare' }), phase: 'traffic', steps: [], windows: w, started_at: at.toISOString() };
  }
  const steps: Json[] = [...state.steps];
  const step = async (name: string, f: () => Promise<Row[]>) => {
    try { const rows = await f(); await store.save(state.run_id, state.windows, rows); steps.push({ name, status: 'succeeded', rows: rows.length }); }
    catch (e) { steps.push({ ...errorInfo(name, e), name, status: 'failed' }); }
  };

  if (state.phase === 'traffic') {
    await step('cloudflare', () => cloudflare(deps, state.windows.traffic));
    await step('bing', () => bing(deps, state.windows.search));
    return { state: { ...state, steps, phase: 'google' }, done: false, action: 'site:traffic' };
  }
  if (state.phase === 'google') {
    let found: Json[] = [];
    await step('google', async () => { const r = await google(deps, state.windows); found = r.failures; return r.rows; });
    for (const f of found) steps.push({ ...f, name: f.step, status: 'failed' });
    // Without a working Google sign-in, nothing Google ran, and URL Inspection would fail too: finish here.
    const signInBroken = steps.some(s => s.name === 'google' && s.status === 'failed');
    if (!signInBroken) for (const n of ['search_console', 'google_analytics']) if (!found.some(f => f.step === n)) steps.push({ name: n, status: 'succeeded' });
    if (signInBroken) return finishRun(store, { ...state, steps }, 'index skipped: Google sign-in failed');
    let queue: string[] = [];
    try { queue = (await sitemapUrls(deps)).slice(0, MAX_URLS); steps.push({ name: 'sitemap', status: 'succeeded', urls: queue.length }); }
    catch (e) { steps.push({ ...errorInfo('sitemap', e), name: 'sitemap', status: 'failed' }); }
    if (!queue.length) return finishRun(store, { ...state, steps }, null);
    return { state: { ...state, steps, phase: 'index', queue, inspected: 0 }, done: false, action: 'site:google' };
  }
  // phase 'index'
  const batch: string[] = state.queue.slice(0, INSPECT_PER_PIECE);
  let ok = true;
  try { await store.save(state.run_id, state.windows, await inspect(deps, batch)); }
  catch (e) { ok = false; steps.push({ ...errorInfo('url_inspection', e), name: 'url_inspection', status: 'failed', remaining: state.queue.length }); }
  const queue = ok ? state.queue.slice(batch.length) : [];
  const next = { ...state, steps, queue, inspected: state.inspected + (ok ? batch.length : 0) };
  if (queue.length) return { state: next, done: false, action: 'site:index' };
  if (ok) steps.push({ name: 'url_inspection', status: 'succeeded', urls: next.inspected });
  return finishRun(store, { ...next, steps }, null);
}

async function finishRun(store: SiteStore, state: Json, note: string | null) {
  const failed = state.steps.filter((s: Json) => s.status === 'failed');
  const status = !failed.length ? 'completed' : state.steps.some((s: Json) => s.status === 'succeeded') ? 'partial' : 'failed';
  const result = { run_id: state.run_id, status, failed: failed.map((s: Json) => `${s.name}: ${s.code}`), ...(note ? { note } : {}) };
  await store.finish(state.run_id, status, { windows: state.windows, steps: state.steps, inspected: state.inspected ?? 0, note });
  const { queue: _, ...rest } = state;
  return { state: { ...rest, phase: 'done', result }, done: true, action: 'site:finish' };
}
