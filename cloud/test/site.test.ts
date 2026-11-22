// example.com: pieces, stored values, digest, failures, and that keys never reach stored data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runOnce } from '../src/jobs.ts';
import type { Deps } from '../src/jobs.ts';
import { windows, googleTokenSource } from '../src/site/sources.ts';
import type { SiteDeps } from '../src/site/sources.ts';
import { siteDigest } from '../src/site/digest.ts';
import { FakeD1 } from './d1.ts';
import type { Env } from '../src/shared.ts';

const SUNDAY = new Date('2026-11-22T05:30:00Z');
const BING_KEY = 'test-bing-key-not-real';
const res = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const bingDate = (d: string) => `/Date(${Date.parse(d + 'T00:00:00Z')})/`;
const URLS = Array.from({ length: 45 }, (_, i) => `https://example.com/p${i}/`);

function fakeFetch(opts: { gaEmpty?: boolean; gscDown?: boolean; notIndexed?: string[] } = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url.replace(BING_KEY, '[key]'));
    let body: any = null; try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
    if (url.includes('api.cloudflare.com/client/v4/graphql')) {
      const q: string = body.query;
      const acc: any = {};
      for (const m of q.matchAll(/(\w+)_(\w+): rum/g)) {
        const [, w, d] = m; const k = `${w}_${d}`; const n = w === 'this' ? 2 : 1;
        acc[k] = d === 'total' ? [{ count: 20 * n, sum: { visits: 10 * n } }]
          : d === 'bio' ? [{ count: 10 * n, sum: { visits: 10 * n }, dimensions: { requestPath: '/ig/' } }, { count: 10, sum: { visits: 10 }, dimensions: { requestPath: '/en/tt' } }]
          : d === 'path' ? [{ count: 10 * n, sum: { visits: 10 }, dimensions: { requestPath: '/' } }]
          : d === 'referer' ? [{ count: 10, sum: { visits: 10 * n }, dimensions: { refererHost: 'l.instagram.com' } }]
          : d === 'country' ? [{ count: 20, sum: { visits: 10 }, dimensions: { countryName: 'IL' } }]
          : d === 'device' ? [{ count: 20, sum: { visits: 10 }, dimensions: { deviceType: 'mobile' } }]
          : [{ count: 20, sum: { visits: 10 }, dimensions: { date: w === 'this' ? '2026-11-20' : '2026-11-10' } }];
      }
      return res({ data: { viewer: { accounts: [acc] } }, errors: null });
    }
    if (url.includes('oauth2.googleapis.com/token')) return res({ access_token: 'google-access' });
    if (url.includes('/searchAnalytics/query')) {
      if (opts.gscDown) return res({ error: { message: 'Search Console says no' } }, 403);
      if (!body.dimensions) return res({ rows: [{ keys: [], clicks: body.startDate === '2026-11-13' ? 3 : 1, impressions: 40, ctr: 0.075, position: 12.5 }] });
      return res({ rows: [{ keys: [body.dimensions[0] === 'query' ? 'סטודיו לדוגמה' : body.dimensions[0] === 'page' ? 'https://example.com/' : '2026-11-15'], clicks: 1, impressions: 10, ctr: 0.1, position: 9 }] });
    }
    if (url.endsWith('/sitemaps')) return res({ sitemap: [{ path: 'https://example.com/sitemap-index.xml', lastDownloaded: '2026-11-15T22:07:59Z', errors: '0', warnings: '0', contents: [{ submitted: '35', indexed: '0' }] }] });
    if (url.includes('analyticsdata.googleapis.com')) {
      const metricHeaders = ['activeUsers', 'sessions', 'engagedSessions', 'screenPageViews'].map(name => ({ name }));
      return res({ reports: body.requests.map((r: any) => opts.gaEmpty ? { metricHeaders } : {
        dimensionHeaders: [...(r.dimensions ?? []), { name: 'dateRange' }], metricHeaders,
        rows: [{ dimensionValues: [...(r.dimensions ? [{ value: r.dimensions[0].name === 'pagePath' ? '/ig/' : 'x' }] : []), { value: 'this' }], metricValues: [{ value: '3' }, { value: '4' }, { value: '2' }, { value: '9' }] }] }) });
    }
    if (url === 'https://example.com/sitemap-index.xml') return res('<sitemapindex><sitemap><loc>https://example.com/sitemap-0.xml</loc></sitemap></sitemapindex>');
    if (url === 'https://example.com/sitemap-0.xml') return res('<urlset>' + URLS.map(u => `<url><loc>${u}</loc></url>`).join('') + '<url><loc>https://evil.example/x</loc></url></urlset>');
    if (url.includes('urlInspection/index:inspect')) {
      const bad = opts.notIndexed?.includes(body.inspectionUrl);
      return res({ inspectionResult: { indexStatusResult: bad ? { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' } : { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-11-18T16:08:58Z' } } });
    }
    if (url.includes('ssl.bing.com')) {
      if (url.includes('GetRankAndTrafficStats')) return res({ d: [{ Date: bingDate('2026-11-15'), Clicks: 1, Impressions: 5 }, { Date: bingDate('2026-11-08'), Clicks: 0, Impressions: 2 }] });
      if (url.includes('GetQueryStats')) return res({ d: [{ Date: bingDate('2026-11-14'), Query: 'example query', Clicks: 1, Impressions: 4 }] });
      if (url.includes('GetPageStats')) return res({ d: [] });
      if (url.includes('GetFeeds')) return res({ d: [{ Url: 'https://example.com/sitemap-index.xml', Status: 'Success', Type: 'Sitemap Index', LastCrawled: bingDate('2026-11-15'), UrlCount: 1 }] });
    }
    return res({ error: 'unexpected ' + url }, 404);
  };
  return { f, calls };
}

function setup(opts: Parameters<typeof fakeFetch>[0] = {}, site: Partial<SiteDeps> = {}) {
  const net = fakeFetch(opts);
  const env = { SITE_DB: new FakeD1(undefined, 'site'), SITE_HOST: 'example.com', SITE_CF_ACCOUNT_ID: 'acct', SITE_CF_SITE_TAG: 'tag', SITE_GA4_PROPERTY: '123', SITE_BIO_PATHS: '/ig/,/tt/,/yt/,/in/,/en/ig/,/en/tt/,/en/yt/,/en/in/' } as unknown as Env & { SITE_DB: FakeD1 };
  const deps = { site: () => ({ fetch: net.f, cfToken: 'cf', bingKey: BING_KEY, googleToken: googleTokenSource(net.f, '{"client_id":"c","client_secret":"s"}', '{"refresh_token":"r"}'), ...site }) } as unknown as Deps;
  const fire = async (n: number) => { const out = []; for (let i = 0; i < n; i++) out.push(await runOnce(env, new Date(SUNDAY.getTime() + i * 300000), deps)); return out; };
  return { env, deps, net, fire };
}

test('windows: traffic is the 7 full days before the run, search ends 3 days earlier', () => {
  assert.deepEqual(windows(SUNDAY), { traffic: { this: { from: '2026-11-15', to: '2026-11-21' }, prev: { from: '2026-11-08', to: '2026-11-14' } },
    search: { this: { from: '2026-11-13', to: '2026-11-19' }, prev: { from: '2026-11-06', to: '2026-11-12' } } });
});

test('pieces: traffic, google, then URL Inspection 40 at a time, then idle; every piece under 50 calls', async () => {
  const { net, env, deps } = setup();
  let before = 0; const perPiece: number[] = [];
  const actions = [];
  for (let i = 0; i < 6; i++) {
    const r = await runOnce(env, new Date(SUNDAY.getTime() + i * 300000), deps);
    actions.push(r.action); perPiece.push(net.calls.length - before); before = net.calls.length;
  }
  assert.deepEqual(actions, ['site:traffic', 'site:google', 'site:index', 'site:finish', 'idle', 'idle']);
  assert.ok(Math.max(...perPiece) < 50, `calls per piece: ${perPiece}`);
  assert.ok(!net.calls.some(c => c.includes('evil.example')), 'only the site’s own URLs are inspected');
  const d = await siteDigest(env.SITE_DB, SUNDAY);
  assert.equal(d.available, true);
  assert.equal(d.run.status, 'completed');
  assert.deepEqual(d.cloudflare.totals, { this: { page_views: 40, visits: 20 }, prev: { page_views: 20, visits: 10 } });
  const bio = Object.fromEntries(d.cloudflare.bio_links.map((b: any) => [b.path, b.this.visits]));
  assert.equal(bio['/ig/'], 20); assert.equal(bio['/en/tt/'], 10, 'a path without the trailing slash counts for its bio link'); assert.equal(bio['/yt/'], 0);
  assert.equal(d.search_console.totals.this.clicks, 3);
  assert.equal(d.search_console.totals.this.position, 12.5);
  assert.equal(d.search_console.queries[0].key, 'סטודיו לדוגמה');
  assert.equal(d.google_analytics.totals.this.sessions, 4);
  assert.equal(d.google_analytics.no_data.prev, true);
  assert.deepEqual(d.bing.totals.this, { clicks: 1, impressions: 5, days_with_data: 1 });
  assert.equal(d.bing.queries[0].key, 'example query');
  assert.equal(d.index.checked, 45); assert.equal(d.index.indexed, 45); assert.deepEqual(d.index.not_indexed, []);
  assert.deepEqual(d.problems, []);
});

test('the Bing key and Google tokens are never stored or reported', async () => {
  const { fire, env } = setup({ gscDown: true });
  await fire(5);
  const dump = JSON.stringify(env.SITE_DB.db.prepare('SELECT * FROM site_values').all()) + JSON.stringify(env.SITE_DB.db.prepare('SELECT * FROM collection_runs').all())
    + JSON.stringify(env.SITE_DB.db.prepare('SELECT * FROM cloud_jobs').all()) + JSON.stringify(await siteDigest(env.SITE_DB, SUNDAY));
  for (const secret of [BING_KEY, 'google-access', '"r"', 'client_secret']) assert.ok(!dump.includes(secret), secret);
});

test('a failing source is recorded and the others still arrive (partial)', async () => {
  const { fire, env } = setup({ gscDown: true });
  await fire(5);
  const d = await siteDigest(env.SITE_DB, SUNDAY);
  assert.equal(d.run.status, 'partial');
  assert.equal(d.search_console, null);
  assert.ok(d.cloudflare && d.google_analytics && d.bing && d.index);
  assert.ok(d.problems.some((p: string) => p.includes('search_console') && p.includes('permission_denied')));
});

test('no Google sign-in: Google and index skipped, Cloudflare and Bing kept', async () => {
  const { fire, env } = setup({}, { googleToken: async () => { const { SiteError } = await import('../src/site/sources.ts'); throw new SiteError('authentication_failed', 'google: the site sign-in expired'); } });
  const out = await fire(3);
  assert.deepEqual(out.map(r => r.action), ['site:traffic', 'site:finish', 'idle']);
  const d = await siteDigest(env.SITE_DB, SUNDAY);
  assert.equal(d.run.status, 'partial'); assert.equal(d.google_analytics, null); assert.equal(d.index, null);
  assert.ok(d.cloudflare);
});

test('GA4 with no data says no_data, never zero', async () => {
  const { fire, env } = setup({ gaEmpty: true });
  await fire(4);
  const d = await siteDigest(env.SITE_DB, SUNDAY);
  assert.deepEqual(d.google_analytics.no_data, { this: true, prev: true });
  assert.deepEqual(d.google_analytics.totals, { this: {}, prev: {} });
});

test('index changes are compared with the previous week', async () => {
  const env = { SITE_DB: new FakeD1(undefined, 'site'), SITE_HOST: 'example.com' } as any;
  for (const [at, bad] of [[SUNDAY, []], [new Date(SUNDAY.getTime() + 7 * 86400000), [URLS[3]]]] as const) {
    const net = fakeFetch({ notIndexed: [...bad] });
    const deps = { site: () => ({ fetch: net.f, cfToken: 'cf', bingKey: BING_KEY, googleToken: async () => 't' }) } as any;
    for (let i = 0; i < 5; i++) await runOnce(env, new Date(at.getTime() + i * 300000), deps);
  }
  const d = await siteDigest(env.SITE_DB, new Date(SUNDAY.getTime() + 7 * 86400000));
  assert.deepEqual(d.index.newly_not_indexed, [URLS[3]]);
  assert.equal(d.index.not_indexed[0].coverage_state, 'Discovered - currently not indexed');
});
