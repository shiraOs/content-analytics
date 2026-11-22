// content-collector: the weekly YouTube / Instagram / TikTok numbers, collected on Cloudflare.
//   Cron (Sundays 05:00–06:55 UTC, every 5 min) → the next piece of this week's collection (src/jobs.ts).
//   GET  /digest  → the weekly digest JSON (src/weekly.ts), read-only.
//   POST /run     → one piece now, same as a cron fire (for testing).
// Both endpoints need `Authorization: Bearer <DIGEST_KEY>`.
import { runOnce } from './jobs.ts';
import { digest } from './weekly.ts';
import type { Env } from './shared.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2),
  { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

// Compares SHA-256 digests in constant time, so the key's length and content don't leak through timing.
export async function authorized(request: Request, key: string | undefined): Promise<boolean> {
  if (!key || key.length < 32) return false;
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([sha(given), sha(key)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export default {
  async scheduled(controller: { scheduledTime: number }, env: Env): Promise<void> {
    console.log(JSON.stringify(await runOnce(env, new Date(controller.scheduledTime))));
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const route = request.method === 'GET' && pathname === '/digest' ? 'digest' : request.method === 'POST' && pathname === '/run' ? 'run' : null;
    if (!route) return json({ error: 'not_found' }, 404);
    if (!env.DIGEST_KEY || env.DIGEST_KEY.length < 32) return json({ error: 'not_configured' }, 503);
    if (!(await authorized(request, env.DIGEST_KEY))) return json({ error: 'unauthorized' }, 401);
    try {
      return json(route === 'digest' ? await digest(env) : await runOnce(env));
    } catch {
      return json({ error: 'internal_error' }, 500);
    }
  }
};
