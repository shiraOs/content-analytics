// The Sunday schedule fires every 5 minutes; each fire does the next unfinished piece of this week's
// work and stops, so no invocation needs more than 50 outside calls (Workers Free).
// Order: YouTube (one piece), TikTok (one piece), Instagram (listing, then 5 Reels per piece).
// A row per platform and day in cloud_jobs holds progress and a 10-minute lease, so two fires never overlap.
import { createYouTubeService, youtubeDeps } from './youtube/service.ts';
import type { YouTubeService } from './youtube/service.ts';
import { History as YouTubeHistory } from './youtube/history.ts';
import { collect as collectYouTube } from './youtube/collect.ts';
import { createTikTokService, tiktokDeps } from './tiktok/service.ts';
import type { TikTokService } from './tiktok/service.ts';
import { History as TikTokHistory } from './tiktok/history.ts';
import { collect as collectTikTok } from './tiktok/collect.ts';
import { createInstagramService, instagramDeps } from './instagram/service.ts';
import type { InstagramService } from './instagram/service.ts';
import { History as InstagramHistory } from './instagram/history.ts';
import { discover, batch, finish, defaults as instagramDefaults } from './instagram/collect.ts';
import { refreshIfDue } from './instagram/core.ts';
import { SiteStore, sitePiece } from './site/collect.ts';
import { googleTokenSource, configureSite } from './site/sources.ts';
import type { SiteDeps } from './site/sources.ts';
import type { Json, Env, D1Database } from './shared.ts';

export type Deps = {
  youtube: (env: Env) => YouTubeService;
  tiktok: (env: Env) => TikTokService;
  instagram: (env: Env) => InstagramService;
  refreshInstagram: (env: Env) => Promise<Json>;
  site?: (env: Env) => SiteDeps;
};
export const defaultDeps: Deps = {
  youtube: env => createYouTubeService(youtubeDeps(env)),
  tiktok: env => createTikTokService(tiktokDeps(env)),
  instagram: env => createInstagramService(instagramDeps(env.INSTAGRAM_DB, env.INSTAGRAM_CREDENTIAL, env.INSTAGRAM_USERNAME)),
  refreshInstagram: env => refreshIfDue(env.INSTAGRAM_DB, env.INSTAGRAM_CREDENTIAL),
  site: env => { const f = (u: string, i?: RequestInit) => fetch(u, { ...i, redirect: 'manual' });
    return { fetch: f, cfToken: env.SITE_CF_TOKEN, bingKey: env.SITE_BING_KEY, googleToken: googleTokenSource(f, env.YOUTUBE_CLIENT, env.SITE_GOOGLE_CREDENTIAL) }; }
};

const LEASE_MS = 10 * 60000;
// Only a network failure is tried again on a later fire (twice at most). Quota, rate limits and
// sign-in problems are never retried.
const NETWORK_RETRIES = 2;
const ERROR_LIMIT = 3;
// The site runs last; it is skipped while SITE_DB is not bound.
export const platforms = ['youtube', 'tiktok', 'instagram', 'site'] as const;
type Platform = typeof platforms[number];
const database = (env: Env, p: Platform) => ({ youtube: env.YOUTUBE_DB, tiktok: env.TIKTOK_DB, instagram: env.INSTAGRAM_DB, site: env.SITE_DB })[p];

async function claim(db: D1Database, week: string, at: Date): Promise<Json | 'done' | 'busy'> {
  const stamp = at.toISOString();
  await db.prepare("INSERT INTO cloud_jobs VALUES (?,'pending',0,NULL,'{}',?) ON CONFLICT(week) DO NOTHING").bind(week, stamp).run();
  const r = await db.prepare("UPDATE cloud_jobs SET lease_until=?,updated_at=? WHERE week=? AND status!='done' AND (lease_until IS NULL OR lease_until<?)")
    .bind(new Date(at.getTime() + LEASE_MS).toISOString(), stamp, week, stamp).run();
  const row = await db.prepare('SELECT * FROM cloud_jobs WHERE week=?').bind(week).first();
  if (r.meta.changes === 1) return row!;
  return row?.status === 'done' ? 'done' : 'busy';
}
async function release(db: D1Database, week: string, status: string, attempts: number, state: Json) {
  await db.prepare('UPDATE cloud_jobs SET status=?,attempts=?,lease_until=NULL,state_json=?,updated_at=? WHERE week=?')
    .bind(status, attempts, JSON.stringify(state), new Date().toISOString(), week).run();
}
const brief = (s: Json) => ({ run_id: s.run_id, status: s.status, stop_reason: s.stop_reason ?? null, ...(s.counts ? { counts: s.counts } : {}) });

// One piece of work. Returns the new state and whether this platform is finished for the week.
async function step(p: Platform, env: Env, deps: Deps, state: Json, at: Date): Promise<{ state: Json; done: boolean; action: string }> {
  if (p === 'site') {
    if (!deps.site) throw new Error('No site dependencies.');
    configureSite(env);
    return sitePiece(new SiteStore(env.SITE_DB!), deps.site(env), state, at);
  }
  if (p === 'youtube' || p === 'tiktok') {
    const summary = p === 'youtube'
      ? await (async () => { const store = new YouTubeHistory(env.YOUTUBE_DB); await store.recover(); return collectYouTube(store, deps.youtube(env), at); })()
      : await (async () => { const store = new TikTokHistory(env.TIKTOK_DB); await store.recover(); return collectTikTok(store, deps.tiktok(env), { days: 60, pages: 5 }, at); })();
    const retries = state.network_retries ?? 0;
    const again = summary.status === 'failed' && summary.stop_reason === 'network_error' && retries < NETWORK_RETRIES;
    return { state: { ...state, run_id: summary.run_id, result: brief(summary), network_retries: again ? retries + 1 : retries }, done: !again, action: 'collect' };
  }
  const store = new InstagramHistory(env.INSTAGRAM_DB);
  const service = deps.instagram(env);
  if (state.phase !== 'reels') {
    await store.recover();
    let token_check: Json;
    try { token_check = await deps.refreshInstagram(env); } catch (e: any) { token_check = { status: 'failed', message: e instanceof Error ? e.message : 'Token check failed.' }; }
    const s = await discover(store, service, instagramDefaults, at, token_check);
    if (!s.queue.length) return { state: { phase: 'done', run_id: s.run_id, token_check, result: brief(await finish(store, s)) }, done: true, action: 'discover' };
    return { state: { phase: 'reels', ...s, token_check }, done: false, action: 'discover' };
  }
  const s = await batch(store, service, { run_id: state.run_id, summary: state.summary, queue: state.queue });
  if (!s.queue.length) return { state: { phase: 'done', run_id: s.run_id, token_check: state.token_check, result: brief(await finish(store, s)) }, done: true, action: 'reels' };
  return { state: { ...state, ...s }, done: false, action: 'reels' };
}

export async function runOnce(env: Env, at = new Date(), deps: Deps = defaultDeps): Promise<Json> {
  const week = at.toISOString().slice(0, 10);
  for (const p of platforms) {
    const db = database(env, p);
    if (!db) continue;
    const claimed = await claim(db, week, at);
    if (claimed === 'done') continue;
    if (claimed === 'busy') return { week, platform: p, action: 'busy' };
    const state = JSON.parse(claimed.state_json);
    const attempts = claimed.attempts + 1;
    try {
      const out = await step(p, env, deps, state, at);
      await release(db, week, out.done ? 'done' : 'in_progress', attempts, out.state);
      return { week, platform: p, action: out.action, done: out.done, result: out.state.result ?? null };
    } catch (e: any) {
      // Unexpected failure (for example a database error): try again on the next fire, three times at most.
      const errors = (state.errors ?? 0) + 1;
      const done = errors >= ERROR_LIMIT;
      await release(db, week, done ? 'done' : 'in_progress', attempts, { ...state, errors, error: String(e?.message ?? 'unknown').slice(0, 200) });
      return { week, platform: p, action: 'error', done };
    }
  }
  return { week, action: 'idle' };
}
