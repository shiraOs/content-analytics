import type { Json, Result } from '../src/youtube/core.ts';
import { createYouTubeService } from '../src/youtube/service.ts';

export const secret = 'ya29.SECRET-ACCESS-TOKEN';
const ok = (endpoint: string, parameters: Json, body: Json, http_status = 200): Result => ({ retrieved_at: new Date().toISOString(), endpoint, parameters, http_status, body });
const header = (names: string[]) => names.map(name => ({ name }));
export const metricsRow = (v: number) => [v * 10, v * 5, 42, 37.5, v, 0, v * 2, 1, 0];
const metricNames = ['views', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'subscribersGained', 'subscribersLost', 'likes', 'comments', 'shares'];
// mode: '' normal · 'mismatch' other channel · 'quota' analytics quota · 'nofilter' Shorts filter rejected · 'auth' 401
export function fixture(mode = '') {
  const calls: Json[] = [];
  const now = Date.now();
  const videos = [
    { id: 'AAAAAAAAAAA', title: 'Skills vs Mods', publishedAt: new Date(now - 10 * 86400000).toISOString(), duration: 'PT9M30S', views: '500' },
    { id: 'BBBBBBBBBBB', title: 'Short one', publishedAt: new Date(now - 8 * 86400000).toISOString(), duration: 'PT44S', views: '900' },
    { id: 'CCCCCCCCCCC', title: 'Brand new', publishedAt: new Date(now - 3600000).toISOString(), duration: 'PT50S', views: '0' }
  ];
  const service = createYouTubeService({
    credentials: async () => { if (mode === 'absent') throw new Error(); return { refresh_token: 'r', channel_id: 'UCexample', saved_at: '2026-10-16T00:00:00Z' }; },
    token: async () => { if (mode === 'revoked') throw Object.assign(new Error('Google rejected the saved sign-in'), { code: 'authentication_failed' }); return secret; },
    request: async (token: string, host: string, endpoint: string, params: Json = {}) => {
      calls.push({ host, endpoint, params });
      const e = `${host}:${endpoint}`;
      if (mode === 'auth') return ok(e, params, { error: { code: 401, message: 'Invalid Credentials ' + token } }, 401);
      if (endpoint === 'channels') return ok(e, params, { items: [{ id: mode === 'mismatch' ? 'UCother' : 'UCexample', snippet: { title: 'Example Creator', customUrl: '@examplecreator', publishedAt: '2026-01-05T10:00:00Z' },
        statistics: { subscriberCount: '120', viewCount: '1400', videoCount: '3' }, contentDetails: { relatedPlaylists: { uploads: 'UUexample' } } }] });
      if (endpoint === 'playlistItems') return params.pageToken
        ? ok(e, params, { items: videos.slice(2).map(v => ({ contentDetails: { videoId: v.id } })) })
        : ok(e, params, { items: videos.slice(0, 2).map(v => ({ contentDetails: { videoId: v.id } })), nextPageToken: 'p2' });
      if (endpoint === 'videos') return ok(e, params, { items: videos.filter(v => params.id.split(',').includes(v.id)).map(v => ({ id: v.id,
        snippet: { channelId: 'UCexample', title: v.title, publishedAt: v.publishedAt, liveBroadcastContent: 'none' }, contentDetails: { duration: v.duration },
        status: { privacyStatus: 'public' }, statistics: { viewCount: v.views, likeCount: '3', commentCount: '1' } })) });
      if (endpoint === 'reports') {
        if (mode === 'quota') return ok(e, params, { error: { code: 403, errors: [{ reason: 'quotaExceeded' }], message: 'quota' } }, 403);
        if (params.filters === 'creatorContentType==shorts') return mode === 'nofilter'
          ? ok(e, params, { error: { code: 400, message: 'bad filter' } }, 400)
          : ok(e, params, { columnHeaders: header(['video', 'views']), rows: [['BBBBBBBBBBB', 9]] });
        if (params.dimensions === 'video') return ok(e, params, { columnHeaders: header(['video', ...metricNames]),
          rows: [['AAAAAAAAAAA', ...metricsRow(params.startDate === '2026-01-05' ? 5 : 2)], ['BBBBBBBBBBB', ...metricsRow(params.startDate === '2026-01-05' ? 3 : 1)]] });
        if (params.dimensions === 'creatorContentType') return ok(e, params, { columnHeaders: header(['creatorContentType', ...metricNames]),
          rows: [['videoOnDemand', ...metricsRow(5)], ['shorts', ...metricsRow(3)]] });
        if (params.dimensions === 'insightTrafficSourceType') return ok(e, params, { columnHeaders: header(['insightTrafficSourceType', 'views', 'estimatedMinutesWatched']),
          rows: [['YT_SEARCH', 30, 10], ['SUBSCRIBER', 20, 8]] });
        return ok(e, params, { columnHeaders: header(metricNames), rows: [metricsRow(8)] });
      }
      return ok(e, params, { error: { message: 'unexpected' } }, 404);
    }
  });
  return { service, calls };
}
