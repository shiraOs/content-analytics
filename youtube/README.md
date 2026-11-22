# YouTube integration and local MCP server

Read-only TypeScript CLI, collector and local MCP server for one creator's own YouTube channel, built the same way as `../instagram/`. Uses the official **YouTube Data API v3** and **YouTube Analytics API** with Google sign-in (OAuth, Desktop app). Requires Node **22.18+**. Permissions asked: `youtube.readonly` and `yt-analytics.readonly` only — nothing can upload, edit, delete or reply.

```sh
cd youtube
npm run auth        # one time: sign in in your own browser
npm run status      # is the sign-in still working?
npm run videos      # uploads with public view counts
npm run collect     # save a dated snapshot to data/history.sqlite
npm run weekly      # read-only digest of YouTube + Instagram history (JSON)
npm test
npm run typecheck
npm run verify:mcp  # live: real MCP client → status, uploads, one video's stats
```

Unattended (for a scheduled job), call Node directly with absolute paths:

```sh
node /path/to/youtube/src/collect.ts
node /path/to/youtube/src/weekly.ts
```

## Files

| File | What it is |
| --- | --- |
| `.client.json` | The Desktop-app OAuth client downloaded from Google Cloud. Private, 0600, git-ignored. |
| `.credentials.json` | Refresh token + channel ID saved by `npm run auth`. Private, 0600, git-ignored. Access tokens stay in memory only. |
| `data/history.sqlite` | Snapshot history (0600 in a 0700 folder). Not encrypted; keep on local disk. |

## What `collect` saves

Every value is an immutable snapshot with its request time, window, dates, unit and source.

- **Public stats** (Data API, `window=public`): channel subscriber/view/video counts; per upload views, likes, comments. Subscriber count is YouTube's rounded public number.
- **Per video** (Analytics, `lifetime` from channel start and `last_7_days`): views, estimatedMinutesWatched (minutes), averageViewDuration (seconds), averageViewPercentage, subscribersGained, subscribersLost, likes, comments, shares.
- **Channel totals** for both windows, overall and split by `creatorContentType` (`channel:shorts`, `channel:videoOnDemand`, …, as YouTube spells them).
- **Traffic sources** (views by `insightTrafficSourceType`) for uploads in their first 28 days, stored as target `<videoId>:traffic:<SOURCE>`.
- **Shorts vs long**: taken from Analytics (`creatorContentType==shorts`). If Google rejects that filter, or an upload has no views yet, it falls back to "3 minutes or less = Short" and marks `type_source: duration_guess`.

Rules the numbers follow:
- Analytics lags about **2–3 days**. A window ending today is short its newest days.
- An upload missing from a report counts as zero only for counters and only if it is older than 3 days; brand-new uploads and averages stay **missing, not zero**. The video report caps at 200 rows.
- Week-over-week change is only calculated for cumulative counters in the `lifetime` or `public` window with matching dates. Averages, percentages and rolling windows are never subtracted.

## Failure behavior

Each step commits on its own, so a later failure keeps earlier numbers. Quota, sign-in, wrong-channel and network errors stop further calls (no retries). Exit codes: **0** completed, **2** partial or failed, **75** another collector running, **130** interrupted, **1** setup error. If Google says the sign-in is expired or revoked, run `npm run auth` again.

If the OAuth consent screen is left in **Testing**, Google expires the sign-in after 7 days — keep it **In production**.

## MCP tools

| Tool | Reads | What |
| --- | --- | --- |
| `youtube_status` | live / local | Sign-in configured? Channel verified? |
| `youtube_list_videos` | live | Uploads, newest first, with public counts |
| `youtube_video_stats` | live | One owned video: lifetime + last 7 days + traffic sources |
| `youtube_metric_history` | local DB | Saved snapshots for a video ID or `channel` |
| `youtube_compare_snapshots` | local DB | Safe difference between two snapshots |

To use it in Claude Code or another MCP client, register `node /path/to/youtube/src/mcp.ts` as a stdio server.
