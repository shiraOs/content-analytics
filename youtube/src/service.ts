import { credentials, tokenSource, request, status, errorSummary, rows, seconds, redact, analyticsMetrics, unit, day } from './core.ts';
import type { Json, Result } from './core.ts';

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
  if (s !== 'available') throw new YouTubeError(s, `${operation} failed. ${s === 'quota_exceeded' ? 'Google quota reached; retry tomorrow.' : s === 'authentication_failed' ? 'Run npm run auth again.' : 'Check connection status and retry.'}`,
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

export function createYouTubeService(deps = { credentials, token: tokenSource(), request }) {
  const owned = new Map<string, Json>();
  async function call(host: 'data' | 'analytics', endpoint: string, params: Json, operation: string) {
    let token: string;
    try { token = await deps.token(); }
    catch (e: any) { throw new YouTubeError(e?.code ?? 'not_configured', e instanceof Error ? e.message : 'Sign-in unavailable. Run npm run auth.'); }
    const r = await deps.request(token, host, endpoint, params);
    try { requireSuccess(r, operation); }
    catch (e) { if (e instanceof YouTubeError) e.details = redact(e.details, [token]); throw e; }
    return r;
  }
  async function channel() {
    let c: Json;
    try { c = await deps.credentials(); } catch { throw new YouTubeError('not_configured', 'No usable YouTube sign-in. Run npm run auth in your own terminal.'); }
    const r = await call('data', 'channels', { part: 'snippet,statistics,contentDetails', mine: 'true' }, 'Channel lookup');
    const ch = r.body.items?.[0];
    if (!ch || r.body.items.length !== 1) throw new YouTubeError('invalid_response', 'Google returned no single channel for this sign-in.');
    if (c.channel_id && ch.id !== c.channel_id) throw new YouTubeError('account_mismatch', 'Sign-in now points to a different channel; collection stopped. Run npm run auth and pick the right channel.');
    const s = ch.statistics ?? {};
    return { id: ch.id as string, title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null,
      published_at: ch.snippet?.publishedAt ?? null, uploads: ch.contentDetails?.relatedPlaylists?.uploads ?? null,
      retrieved_at: r.retrieved_at,
      public: [observation('channel', null, 'subscriberCount', s.hiddenSubscriberCount ? null : s.subscriberCount, r.retrieved_at, 'data_api'),
        observation('channel', null, 'viewCount', s.viewCount, r.retrieved_at, 'data_api'),
        observation('channel', null, 'videoCount', s.videoCount, r.retrieved_at, 'data_api')] };
  }
  async function listVideos(max = 200, pages = 10) {
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
        const video = { id: v.id, title: v.snippet?.title ?? null, published_at: v.snippet?.publishedAt ?? null,
          duration_seconds: seconds(v.contentDetails?.duration), privacy: v.status?.privacyStatus ?? null,
          live: v.snippet?.liveBroadcastContent ?? null, url: `https://www.youtube.com/watch?v=${v.id}`,
          public: [observation(v.id, null, 'viewCount', v.statistics?.viewCount, r.retrieved_at, 'data_api'),
            observation(v.id, null, 'likeCount', v.statistics?.likeCount, r.retrieved_at, 'data_api'),
            observation(v.id, null, 'commentCount', v.statistics?.commentCount, r.retrieved_at, 'data_api')] };
        videos.push(video); owned.set(v.id, video); if (owned.size > 1000) owned.delete(owned.keys().next().value!);
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
  async function requireOwned(videoId: string) {
    if (!owned.has(videoId)) await listVideos();
    const v = owned.get(videoId);
    if (!v) throw new YouTubeError('ownership_not_verified', 'That video is not among this channel’s uploads.');
    return v;
  }
  return {
    channel, listVideos, videoMetrics, shortIds, channelTotals, trafficSources, windows,
    async connectionStatus(verify = true) {
      let c: Json;
      try { c = await deps.credentials(); } catch { return { credentials_configured: false, connection_verified: false, health: 'not_configured', checked_at: new Date().toISOString() }; }
      const base = { credentials_configured: true, credential: { saved_at: c.saved_at ?? null, channel_id: c.channel_id ?? null, channel_title: c.channel_title ?? null, scope: c.scope ?? null },
        connection_verified: false, checked_at: new Date().toISOString() };
      if (!verify) return sanitize({ ...base, health: 'not_checked' });
      try { const ch = await channel(); return sanitize({ ...base, channel: { id: ch.id, title: ch.title, handle: ch.handle }, connection_verified: true, health: 'healthy' }); }
      catch (e) { return sanitize({ ...base, health: e instanceof YouTubeError ? e.code : 'internal_error' }); }
    },
    async videoStats(videoId: string) {
      const v = await requireOwned(videoId);
      const published = typeof v.published_at === 'string' ? v.published_at.slice(0, 10) : '2005-02-14';
      const end = day(new Date());
      const out: Json = { video: sanitize(v), windows: [] };
      for (const w of [{ name: 'lifetime', start: published, end }, { name: 'last_7_days', start: day(new Date(Date.now() - 6 * 86400000)), end }]) {
        const r = await report({ startDate: w.start, endDate: w.end, metrics: analyticsMetrics.join(','), filters: `video==${videoId}` }, `Video analytics (${w.name})`);
        out.windows.push({ window: w, retrieved_at: r.retrieved_at, metrics: r.rows[0] ?? null,
          note: 'YouTube Analytics usually lags 2–3 days; the last days of a window may be empty, not zero.' });
      }
      out.traffic_sources = await trafficSources(videoId, { name: 'lifetime', start: published, end });
      return out;
    }
  };
}
export type YouTubeService = ReturnType<typeof createYouTubeService>;
