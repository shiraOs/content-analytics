// Read-only calls for the site: Cloudflare Web Analytics (GraphQL), Search Console, Google Analytics 4
// (Data API) and Bing Webmaster. Each returns plain rows; nothing here touches the database.
// Never put a token or key in an error message: Bing's key travels in the URL, so URLs are never reported.
import type { Json } from '../shared.ts';

// Which site to read. Set as Worker vars in wrangler.jsonc (none of these are secret):
// SITE_HOST, SITE_CF_ACCOUNT_ID, SITE_CF_SITE_TAG, SITE_GA4_PROPERTY. jobs.ts calls configureSite(env) before each piece.
export const config = { host: '', accountId: '', siteTag: '', gscSite: '', ga4Property: '', bingSite: '', sitemap: '' };
export type SiteVars = { SITE_HOST?: string; SITE_CF_ACCOUNT_ID?: string; SITE_CF_SITE_TAG?: string; SITE_GA4_PROPERTY?: string; SITE_BIO_PATHS?: string };
export function configureSite(vars: SiteVars) {
  const host = vars.SITE_HOST ?? '';
  Object.assign(config, { host, accountId: vars.SITE_CF_ACCOUNT_ID ?? '', siteTag: vars.SITE_CF_SITE_TAG ?? '', ga4Property: vars.SITE_GA4_PROPERTY ?? '',
    gscSite: `sc-domain:${host}`, bingSite: `https://${host}/`, sitemap: `https://${host}/sitemap-index.xml` });
  const paths = (vars.SITE_BIO_PATHS ?? '').split(',').map(p => p.trim()).filter(p => p.startsWith('/')).map(p => p.endsWith('/') ? p : p + '/');
  bioPaths.splice(0, bioPaths.length, ...paths);
}
// Optional per-network "link in bio" pages, such as /ig/ and /tt/, counted on their own.
// Set SITE_BIO_PATHS to a comma-separated list; leave it empty to skip.
export const bioPaths: string[] = [];

export type Window = { from: string; to: string };
export type Windows = { traffic: { this: Window; prev: Window }; search: { this: Window; prev: Window } };
export type Row = { source: string; window: 'this' | 'prev' | 'now'; dimension: string; key: string; metric: string; value: unknown };
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type SiteDeps = { fetch: Fetch; cfToken?: string; googleToken: () => Promise<string>; bingKey?: string };

export class SiteError extends Error {
  code: string; http_status: number | null;
  constructor(code: string, message: string, http_status: number | null = null) { super(message); this.code = code; this.http_status = http_status; }
}

const day = (at: Date, back: number) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - back * 86400000).toISOString().slice(0, 10);
// Traffic (Cloudflare, GA4): the 7 full UTC days before the run vs the 7 before those.
// Search (Search Console, Bing): data lags 2–3 days, so the same windows end 3 days earlier.
export function windows(at: Date): Windows {
  return { traffic: { this: { from: day(at, 7), to: day(at, 1) }, prev: { from: day(at, 14), to: day(at, 8) } },
    search: { this: { from: day(at, 9), to: day(at, 3) }, prev: { from: day(at, 16), to: day(at, 10) } } };
}

const clip = (s: unknown) => String(s ?? '').slice(0, 300);
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

function fail(source: string, status: number | null, detail?: string): never {
  const code = status === null ? 'network_error' : status === 401 ? 'authentication_failed' : status === 403 ? 'permission_denied'
    : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : `http_${status}`;
  throw new SiteError(code, `${source}: ${code}${detail ? ' — ' + clip(detail).slice(0, 160) : ''}`, status);
}
async function call(deps: SiteDeps, source: string, url: string, init: RequestInit = {}): Promise<any> {
  let r: Response;
  // 20 s per call: a hung request must not eat the invocation's time.
  try { r = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20000) }); } catch { fail(source, null); }
  const text = await r.text().catch(() => '');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!r.ok) fail(source, r.status, typeof body === 'object' ? body?.error?.message ?? body?.Message ?? body?.errors?.[0]?.message : undefined);
  return body;
}

// ---------- Cloudflare Web Analytics ----------
// count = page views, sum.visits = visits. Cloudflare samples this data (adaptive), so small numbers come in steps.
export async function cloudflare(deps: SiteDeps, w: Windows['traffic']): Promise<Row[]> {
  if (!deps.cfToken) throw new SiteError('not_configured', 'cloudflare: no API token stored (SITE_CF_TOKEN).');
  const filter = (x: Window, extra = '') => `filter:{date_geq:"${x.from}", date_leq:"${x.to}", siteTag:"${config.siteTag}"${extra}}`;
  const bioIn = JSON.stringify(bioPaths.flatMap(p => [p, p.slice(0, -1)]));
  const parts: string[] = [];
  const dims: Record<string, string> = { path: 'requestPath', referer: 'refererHost', country: 'countryName', device: 'deviceType', date: 'date' };
  for (const name of ['this', 'prev'] as const) {
    const x = w[name];
    parts.push(`${name}_total: rumPageloadEventsAdaptiveGroups(limit:1, ${filter(x)}) { count sum { visits } }`);
    parts.push(`${name}_bio: rumPageloadEventsAdaptiveGroups(limit:50, ${filter(x, `, requestPath_in:${bioIn}`)}) { count sum { visits } dimensions { requestPath } }`);
    for (const [d, field] of Object.entries(dims)) {
      parts.push(`${name}_${d}: rumPageloadEventsAdaptiveGroups(limit:${d === 'date' ? 10 : 25}, ${filter(x)}, orderBy:[${d === 'date' ? 'date_ASC' : 'count_DESC'}]) { count sum { visits } dimensions { ${field} } }`);
    }
  }
  const query = `{ viewer { accounts(filter:{accountTag:"${config.accountId}"}) { ${parts.join(' ')} } } }`;
  const body = await call(deps, 'cloudflare', 'https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${deps.cfToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  if (body?.errors?.length) throw new SiteError('api_error', `cloudflare: ${clip(body.errors[0]?.message).slice(0, 160)}`);
  const acc = body?.data?.viewer?.accounts?.[0];
  if (!acc) throw new SiteError('permission_denied', 'cloudflare: the token cannot read this account.');
  const rows: Row[] = [];
  for (const name of ['this', 'prev'] as const) {
    const t = acc[`${name}_total`]?.[0];
    rows.push({ source: 'cloudflare', window: name, dimension: 'total', key: 'all', metric: 'page_views', value: t ? num(t.count) : 0 },
      { source: 'cloudflare', window: name, dimension: 'total', key: 'all', metric: 'visits', value: t ? num(t.sum?.visits) : 0 });
    // Bio links: every one of the eight is reported, 0 when Cloudflare saw none (the dataset was readable).
    const bio = new Map(bioPaths.map(p => [p, { page_views: 0, visits: 0 }]));
    for (const g of acc[`${name}_bio`] ?? []) {
      const p = String(g.dimensions.requestPath); const key = p.endsWith('/') ? p : p + '/';
      const b = bio.get(key); if (b) { b.page_views += num(g.count) ?? 0; b.visits += num(g.sum?.visits) ?? 0; }
    }
    for (const [p, v] of bio) rows.push({ source: 'cloudflare', window: name, dimension: 'bio', key: p, metric: 'page_views', value: v.page_views },
      { source: 'cloudflare', window: name, dimension: 'bio', key: p, metric: 'visits', value: v.visits });
    for (const [d, field] of Object.entries(dims)) for (const g of acc[`${name}_${d}`] ?? []) {
      const key = clip(g.dimensions[field]) || '(none)';
      rows.push({ source: 'cloudflare', window: name, dimension: d, key, metric: 'page_views', value: num(g.count) },
        { source: 'cloudflare', window: name, dimension: d, key, metric: 'visits', value: num(g.sum?.visits) });
    }
  }
  return rows;
}

// ---------- Google: Search Console + GA4 (one access token) ----------
const gsc = (path: string) => `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(config.gscSite)}${path}`;
// With no impressions, CTR and position mean nothing (Google sends 0): store them as missing.
const searchMetrics = (r: any) => { const shown = (num(r.impressions) ?? 0) > 0;
  return { clicks: num(r.clicks), impressions: num(r.impressions), ctr: shown ? num(r.ctr) : null, position: shown ? num(r.position) : null }; };

export async function google(deps: SiteDeps, w: Windows): Promise<{ rows: Row[]; failures: Json[] }> {
  const token = await deps.googleToken();
  const json = (body: unknown) => ({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const rows: Row[] = []; const failures: Json[] = [];
  const part = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e) { failures.push(errorInfo(name, e)); } };

  await part('search_console', async () => {
    for (const name of ['this', 'prev'] as const) {
      const x = w.search[name];
      const q = (extra: Json) => call(deps, 'search_console', gsc('/searchAnalytics/query'), json({ startDate: x.from, endDate: x.to, ...extra }));
      const total = await q({});
      const t = total?.rows?.[0];
      // No rows means Google recorded no search appearances in the window: that is a real zero.
      for (const [m, v] of Object.entries(t ? searchMetrics(t) : { clicks: 0, impressions: 0, ctr: null, position: null }))
        rows.push({ source: 'search_console', window: name, dimension: 'total', key: 'all', metric: m, value: v });
      for (const [dim, limit] of [['query', 25], ['page', 25], ['date', 10]] as const) {
        const r = await q({ dimensions: [dim], rowLimit: limit });
        for (const row of r?.rows ?? []) for (const [m, v] of Object.entries(searchMetrics(row)))
          rows.push({ source: 'search_console', window: name, dimension: dim, key: clip(row.keys?.[0]), metric: m, value: v });
      }
    }
    const sm = await call(deps, 'search_console', gsc('/sitemaps'), { headers: { Authorization: `Bearer ${token}` } });
    for (const s of sm?.sitemap ?? []) rows.push({ source: 'search_console', window: 'now', dimension: 'sitemap', key: clip(s.path), metric: 'status',
      value: { last_downloaded: s.lastDownloaded ?? null, last_submitted: s.lastSubmitted ?? null, errors: num(s.errors), warnings: num(s.warnings),
        is_pending: s.isPending ?? null, submitted: num(s.contents?.[0]?.submitted) } });
  });

  await part('google_analytics', async () => {
    const metrics = ['activeUsers', 'sessions', 'engagedSessions', 'screenPageViews'].map(name => ({ name }));
    const ranges = [{ startDate: w.traffic.this.from, endDate: w.traffic.this.to, name: 'this' }, { startDate: w.traffic.prev.from, endDate: w.traffic.prev.to, name: 'prev' }];
    const reports: [string, string | null, number][] = [['total', null, 2], ['path', 'pagePath', 50], ['source', 'sessionSourceMedium', 25], ['country', 'country', 15], ['device', 'deviceCategory', 5]];
    const body = await call(deps, 'google_analytics', `https://analyticsdata.googleapis.com/v1beta/properties/${config.ga4Property}:batchRunReports`, json({
      requests: reports.map(([, dim, limit]) => ({ dateRanges: ranges, metrics, ...(dim ? { dimensions: [{ name: dim }] } : {}), limit })) }));
    const seen = new Set<string>();
    (body?.reports ?? []).forEach((rep: any, i: number) => {
      const [dimension] = reports[i];
      const headers = (rep.dimensionHeaders ?? []).map((h: any) => h.name);
      const names = (rep.metricHeaders ?? []).map((h: any) => h.name);
      for (const r of rep.rows ?? []) {
        const dv = Object.fromEntries(headers.map((h: string, j: number) => [h, r.dimensionValues?.[j]?.value]));
        const window = dv.dateRange === 'prev' ? 'prev' : 'this';
        const key = dimension === 'total' ? 'all' : clip(dv[reports[i][1]!]) || '(not set)';
        if (dimension === 'total') seen.add(window);
        names.forEach((m: string, j: number) => rows.push({ source: 'google_analytics', window, dimension, key, metric: m, value: num(r.metricValues?.[j]?.value) }));
      }
    });
    // GA4 leaves out a date range with no data. Say so with an explicit marker instead of a zero.
    for (const window of ['this', 'prev'] as const) if (!seen.has(window))
      rows.push({ source: 'google_analytics', window, dimension: 'total', key: 'all', metric: 'no_data', value: true });
  });
  return { rows, failures };
}

// ---------- Search Console URL Inspection (index state per sitemap URL) ----------
export async function sitemapUrls(deps: SiteDeps): Promise<string[]> {
  const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1].replace(/&amp;/g, '&'));
  const get = async (url: string) => { let r: Response; try { r = await deps.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000) }); } catch { fail('sitemap', null); } if (!r.ok) fail('sitemap', r.status); return r.text(); };
  const index = await get(config.sitemap);
  const out: string[] = [];
  for (const child of locs(index).filter(u => u.startsWith(`https://${config.host}/`)).slice(0, 5)) out.push(...locs(await get(child)));
  return [...new Set(out.filter(u => u.startsWith(`https://${config.host}/`)))];
}
export async function inspect(deps: SiteDeps, urls: string[]): Promise<Row[]> {
  const token = await deps.googleToken();
  const rows: Row[] = [];
  for (const url of urls) {
    const body = await call(deps, 'url_inspection', 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inspectionUrl: url, siteUrl: config.gscSite }) });
    const r = body?.inspectionResult?.indexStatusResult ?? {};
    rows.push({ source: 'url_inspection', window: 'now', dimension: 'index', key: url, metric: 'status', value: {
      verdict: r.verdict ?? null, coverage_state: r.coverageState ?? null, indexing_state: r.indexingState ?? null,
      last_crawl: r.lastCrawlTime ?? null, page_fetch: r.pageFetchState ?? null, robots: r.robotsTxtState ?? null, google_canonical: r.googleCanonical ?? null } });
  }
  return rows;
}

// ---------- Bing Webmaster ----------
const bingDate = (s: unknown) => { const m = /\/Date\((-?\d+)/.exec(String(s)); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null; };
export async function bing(deps: SiteDeps, w: Windows['search']): Promise<Row[]> {
  if (!deps.bingKey) throw new SiteError('not_configured', 'bing: no API key stored (SITE_BING_KEY).');
  const get = (method: string, site = true) => call(deps, 'bing', `https://ssl.bing.com/webmaster/api.svc/json/${method}?${site ? 'siteUrl=' + encodeURIComponent(config.bingSite) + '&' : ''}apikey=${encodeURIComponent(deps.bingKey!)}`);
  const inWindow = (d: string | null, x: Window) => d !== null && d >= x.from && d <= x.to;
  const rows: Row[] = [];
  const traffic = (await get('GetRankAndTrafficStats'))?.d ?? [];
  for (const name of ['this', 'prev'] as const) {
    const days = traffic.filter((r: any) => inWindow(bingDate(r.Date), w[name]));
    rows.push({ source: 'bing', window: name, dimension: 'total', key: 'all', metric: 'clicks', value: days.reduce((s: number, r: any) => s + (num(r.Clicks) ?? 0), 0) },
      { source: 'bing', window: name, dimension: 'total', key: 'all', metric: 'impressions', value: days.reduce((s: number, r: any) => s + (num(r.Impressions) ?? 0), 0) },
      { source: 'bing', window: name, dimension: 'total', key: 'all', metric: 'days_with_data', value: days.length });
  }
  for (const [method, dimension] of [['GetQueryStats', 'query'], ['GetPageStats', 'page']] as const) {
    const sum = new Map<string, { clicks: number; impressions: number }>();
    for (const r of (await get(method))?.d ?? []) {
      if (!inWindow(bingDate(r.Date), w.this)) continue;
      const k = clip(r.Query); const v = sum.get(k) ?? { clicks: 0, impressions: 0 };
      v.clicks += num(r.Clicks) ?? 0; v.impressions += num(r.Impressions) ?? 0; sum.set(k, v);
    }
    for (const [k, v] of [...sum].sort((a, b) => b[1].impressions - a[1].impressions).slice(0, 25))
      rows.push({ source: 'bing', window: 'this', dimension, key: k, metric: 'clicks', value: v.clicks }, { source: 'bing', window: 'this', dimension, key: k, metric: 'impressions', value: v.impressions });
  }
  for (const f of (await get('GetFeeds'))?.d ?? []) rows.push({ source: 'bing', window: 'now', dimension: 'sitemap', key: clip(f.Url), metric: 'status',
    value: { status: f.Status ?? null, type: f.Type ?? null, last_crawled: bingDate(f.LastCrawled), submitted: bingDate(f.Submitted), url_count: num(f.UrlCount) } });
  return rows;
}

export function errorInfo(step: string, e: unknown): Json {
  return e instanceof SiteError ? { step, code: e.code, message: e.message, http_status: e.http_status } : { step, code: 'internal_error', message: `${step}: unexpected error` };
}

// Google access token from the stored refresh token and the YouTube Desktop client (same Google Cloud project).
export function googleTokenSource(f: Fetch, clientSecret?: string, credentialSecret?: string): () => Promise<string> {
  let cached: string | null = null;
  return async () => {
    if (cached) return cached;
    let client: any, cred: any;
    try { client = JSON.parse(clientSecret ?? ''); cred = JSON.parse(credentialSecret ?? ''); } catch { throw new SiteError('not_configured', 'google: sign-in not stored (YOUTUBE_CLIENT / SITE_GOOGLE_CREDENTIAL).'); }
    if (!client?.client_id || !cred?.refresh_token) throw new SiteError('not_configured', 'google: sign-in not stored (YOUTUBE_CLIENT / SITE_GOOGLE_CREDENTIAL).');
    let r: Response;
    try {
      r = await f('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: cred.refresh_token, grant_type: 'refresh_token' }) });
    } catch { throw new SiteError('network_error', 'google: network error while refreshing the sign-in.'); }
    const body: any = await r.json().catch(() => ({}));
    if (typeof body.access_token !== 'string') throw new SiteError(body.error === 'invalid_grant' ? 'authentication_failed' : `http_${r.status}`,
      body.error === 'invalid_grant' ? 'google: the site sign-in expired or was revoked (npm run auth in site/, then npm run secrets).' : `google: token refresh failed (HTTP ${r.status}).`, r.status);
    return (cached = body.access_token);
  };
}
