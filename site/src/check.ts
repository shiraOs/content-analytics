// Quick live check of the Google side (no tokens printed). Usage: node src/check.ts [ga4PropertyId]
import { accessToken, getJson } from './google.ts';

const host = process.env.SITE_HOST;
if (!host) { console.error('Set SITE_HOST, e.g. SITE_HOST=example.com node src/check.ts <GA4 property>'); process.exit(1); }
const site = `sc-domain:${host}`;
const token = await accessToken();
const sa = (body: unknown) => getJson(token, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, body);

const daily = await sa({ startDate: '2026-10-20', endDate: '2026-11-20', dimensions: ['date'], dataState: 'all' });
console.log('GSC by date', daily.http_status, JSON.stringify(daily.body.rows?.map((r: any) => [r.keys[0], r.clicks, r.impressions]) ?? daily.body.error?.message));
const q = await sa({ startDate: '2026-10-20', endDate: '2026-11-20', dimensions: ['query'], rowLimit: 10 });
console.log('GSC queries', q.http_status, JSON.stringify(q.body.rows?.map((r: any) => [r.keys[0], r.clicks, r.impressions, +r.position.toFixed(1)]) ?? q.body.error?.message));

const sm = await getJson(token, `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps`);
console.log('GSC sitemaps', sm.http_status, JSON.stringify(sm.body.sitemap?.map((s: any) => [s.path, s.lastDownloaded, s.errors, s.warnings, s.contents]) ?? sm.body.error?.message));

const ins = await getJson(token, 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', { inspectionUrl: `https://${host}/`, siteUrl: site });
const r = ins.body.inspectionResult?.indexStatusResult;
console.log('URL inspection /', ins.http_status, JSON.stringify(r ? { verdict: r.verdict, coverageState: r.coverageState, lastCrawlTime: r.lastCrawlTime } : ins.body.error?.message));

const prop = process.argv[2];
if (prop) {
  const ga = await getJson(token, `https://analyticsdata.googleapis.com/v1beta/properties/${prop}:runReport`, {
    dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], limit: 10 });
  console.log('GA4', ga.http_status, JSON.stringify(ga.body.rows?.map((x: any) => [x.dimensionValues[0].value, ...x.metricValues.map((m: any) => m.value)]) ?? ga.body.error?.message ?? 'no rows'));
}
