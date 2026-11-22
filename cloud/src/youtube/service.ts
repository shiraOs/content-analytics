// Port of youtube/src/service.ts (the collector half; the MCP-only lookups stay on your computer).
import { credentials, oauthClient, postToken, tokenSource, request, status, errorSummary, rows, seconds, redact, analyticsMetrics, unit, day, reauth } from './core.ts';
import type { Json, Result } from './core.ts';
import type { Env } from '../shared.ts';

export class YouTubeError extends Error {
  code: string;
  details: Json;
  constructor(code: string, message: string, details: Json = {}) {
    super(message); this.code = code; this.details = details;
  }
}
// Public output never includes raw API bodies or URLs carrying credentials.
export function sanitize(value: any): any {
  const clean = redact(value);
  if (typeof clean === 'string') return clean.replace(/https?:\/\/[^\s"<>]+/gi,
    url => /access_token|refresh_token|client_secret|\[REDACTED\]/i.test(url) ? '[credential URL removed]' : url);
  if (Array.isArray(clean)) return clean.map(v => sanitize(v));
  if (clean && typeof clean === 'object') return Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, sanitize(v)]));
  return clean;
}
function requireSuccess(r: Result, operation: string) {
  const s = status(r);
  if (s !== 'available') throw new YouTubeError(s, `${operation} failed. ${s === 'quota_exceeded' ? 'Google quota reached; retry tomorrow.' : s === 'authentication_failed' ? reauth : 'Check connection status and retry.'}`,
    { ...errorSummary(r), retrieved_at: r.retrieved_at });
}
export type Window = { name: string; start: string; end: string };
export function windows(channelPublished: string | null, at = new Date()): Window[] {
  const end = day(at);
  const start7 = day(new Date(at.getTime() - 6 * 86400000));
  const born = channelPublished && /^\d{4}-\d\d-\d\d/.test(channelPublished) ? channelPublished.slice(0, 10) : '2005-02-14';
  return [{ name: 'lifetime', start: born, end }, { name: 'last_7_days', start: start7, end }];
}
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null;
const observation = (target: string, w: Window | null, name: string, value: unknown, retrieved_at: string, source: string) =>
  ({ target, window: w?.name ?? 'public', start_date: w?.start ?? null, end_date: w?.end ?? null, name, unit: unit(name),
    status: num(value) === null ? 'missing' : 'available', value: num(value), retrieved_at, source });

export type YouTubeDeps = { credentials: () => Promise<Json>; token: () => Promise<string>; request: typeof request };
export const youtubeDeps = (env: Env): YouTubeDeps => ({ credentials: credentials(env),
  token: tokenSource({ oauthClient: oauthClient(env), credentials: credentials(env), postToken }), request });

export function createYouTubeService(deps: YouTubeDeps) {
  async function call(host: 'data' | 'analytics', endpoint: string, params: Json, operation: string) {
    let token: string;
    try { token = await deps.token(); }
    catch (e: any) { throw new YouTubeError(e?.code ?? 'not_configured', e instanceof Error ? e.message : 'Sign-in unavailable. ' + reauth); }
    const r = await deps.request(token, host, endpoint, params);
    try { requireSuccess(r, operation); }
    catch (e) { if (e instanceof YouTubeError) e.details = redact(e.details, [token]); throw e; }
    return r;
  }
  async function channel() {
    let c: Json;
    try { c = await deps.credentials(); } catch { throw new YouTubeError('not_configured', 'No usable YouTube sign-in. ' + reauth); }
    const r = await call('data', 'channels', { part: 'snippet,statistics,contentDetails', mine: 'true' }, 'Channel lookup');
    const ch = r.body.items?.[0];
    if (!ch || r.body.items.length !== 1) throw new YouTubeError('invalid_response', 'Google returned no single channel for this sign-in.');
    if (c.channel_id && ch.id !== c.channel_id) throw new YouTubeError('account_mismatch', 'Sign-in now points to a different channel; collection stopped. ' + reauth);
    const s = ch.statistics ?? {};
    return { id: ch.id as string, title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
      published_at: ch.snippet?.publishedAt ?? null, uploads: ch.contentDetails?.relatedPlaylists?.uploads ?? null,
      retrieved_at: r.retrieved_at,
      public: [observation('channel', null, 'subscriberCount', s.hiddenSubscriberCount ? null : s.subscriberCount, r.retrieved_at, 'data_api'),
        observation('channel', null, 'viewCount', s.viewCount, r.retrieved_at, 'data_api'),
        observation('channel', null, 'videoCount', s.videoCount, r.retrieved_at, 'data_api')] };
  }
  // Pages capped at 4 here (200 uploads), so a whole YouTube collection stays inside one free-plan invocation.
  async function listVideos(max = 200, pages = 4) {
    const ch = await channel();
    if (!ch.uploads) throw new YouTubeError('invalid_response', 'Channel has no uploads playlist.');
    const ids: string[] = []; let pageToken: string | undefined; let complete = false; const seen = new Set<string>();
    for (let p = 0; p < pages && ids.length < max; p++) {
      const r = await call('data', 'playlistItems', { part: 'contentDetails', playlistId: ch.uploads, maxResults: 50, ...(pageToken ? { pageToken } : {}) }, 'Uploads listing');
      for (const it of r.body.items ?? []) { const id = it.contentDetails?.videoId; if (typeof id === 'string' && !seen.has(id) && ids.length < max) { seen.add(id); ids.push(id); } }
      pageToken = r.body.nextPageToken;
      if (!pageToken) { complete = true; break; }
    }
    const videos: Json[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await call('data', 'videos', { part: 'snippet,contentDetails,statistics,status', id: ids.slice(i, i + 50).join(',') }, 'Video details');
      for (const v of r.body.items ?? []) {
        if (v.snippet?.channelId !== ch.id) continue;
        videos.push({ id: v.id, title: v.snippet?.title ?? null, published_at: v.snippet?.publishedAt ?? null,
          duration_seconds: seconds(v.contentDetails?.duration), privacy: v.status?.privacyStatus ?? null,
          live: v.snippet?.liveBroadcastContent ?? null, url: `https://www.youtube.com/watch?v=${v.id}`,
          public: [observation(v.id, null, 'viewCount', v.statistics?.viewCount, r.retrieved_at, 'data_api'),
            observation(v.id, null, 'likeCount', v.statistics?.likeCount, r.retrieved_at, 'data_api'),
            observation(v.id, null, 'commentCount', v.statistics?.commentCount, r.retrieved_at, 'data_api')] });
      }
    }
    videos.sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
    return { channel: ch, videos, discovery_complete: complete, retrieved_at: new Date().toISOString() };
  }
  async function report(params: Json, operation: string) {
    const r = await call('analytics', 'reports', { ids: 'channel==MINE', ...params }, operation);
    return { rows: rows(r.body), retrieved_at: r.retrieved_at };
  }
  // Per-video metrics for one window. The video dimension caps at 200 rows sorted by views.
  async function videoMetrics(w: Window) {
    const r = await report({ startDate: w.start, endDate: w.end, dimensions: 'video', metrics: analyticsMetrics.join(','), sort: '-views', maxResults: 200 }, `Video analytics (${w.name})`);
    return { window: w, retrieved_at: r.retrieved_at, rows: r.rows };
  }
  // Which uploads YouTube counts as Shorts. Falls back to null when the filter is rejected.
  // The value must be lowercase: Google answers HTTP 400 to `creatorContentType==SHORTS`.
  async function shortIds(w: Window): Promise<Set<string> | null> {
    try {
      const r = await report({ startDate: w.start, endDate: w.end, dimensions: 'video', metrics: 'views', filters: 'creatorContentType==shorts', sort: '-views', maxResults: 200 }, 'Shorts lookup');
      return new Set(r.rows.map(x => x.video));
    } catch (e) { if (e instanceof YouTubeError && e.code === 'bad_request') return null; throw e; }
  }
  async function channelTotals(w: Window) {
    const all = await report({ startDate: w.start, endDate: w.end, metrics: analyticsMetrics.join(',') }, `Channel analytics (${w.name})`);
    let byType: Json[] = [];
    try { byType = (await report({ startDate: w.start, endDate: w.end, dimensions: 'creatorContentType', metrics: analyticsMetrics.join(',') }, 'Channel by content type')).rows; }
    catch (e) { if (!(e instanceof YouTubeError && e.code === 'bad_request')) throw e; }
    return { window: w, retrieved_at: all.retrieved_at, total: all.rows[0] ?? null, by_type: byType };
  }
  async function trafficSources(videoId: string, w: Window) {
    const r = await report({ startDate: w.start, endDate: w.end, dimensions: 'insightTrafficSourceType', metrics: 'views,estimatedMinutesWatched', filters: `video==${videoId}`, sort: '-views' }, 'Traffic sources');
    return { video_id: videoId, window: w, retrieved_at: r.retrieved_at, rows: r.rows };
  }
  return { channel, listVideos, videoMetrics, shortIds, channelTotals, trafficSources, windows };
}
export type YouTubeService = ReturnType<typeof createYouTubeService>;
