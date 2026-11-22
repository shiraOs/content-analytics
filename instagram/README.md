# Instagram integration and local MCP server

Read-only TypeScript CLI, collector and local MCP server for one Instagram professional account, using the Instagram API with Instagram Login. Requires Node **22.18+**. Run `npm ci` first.

Set `INSTAGRAM_USERNAME` to the account you sign in with (for example `export INSTAGRAM_USERNAME=your.handle`). The CLI, collector and MCP server check that the token belongs to that account and stop if it does not.

```sh
npm run auth             # one time: paste the token from the Meta app dashboard (input hidden)
npm run fetch            # newest Reel and its insights (or -- --list, -- --media-id ID)
npm run refresh-if-due   # renew the long-lived token when it is close to expiry
npm run collect          # save a dated snapshot to data/history.sqlite
npm run collect -- --days 30 --pages 5 --page-size 25 --reels 25
npm run import:history   # import saved API responses into the history database
npm test
npm run typecheck
```

| Option | Default | Allowed | Meaning |
| --- | --- | --- | --- |
| `--days` | 30 | 1–30 | How far back to look for Reels, in UTC days |
| `--pages` | 5 | 1–20 | Most pages of media to read |
| `--page-size` | 25 | 1–50 | Most media per page |
| `--reels` | 25 | 1–100 | Most Reels to fetch insights for |

A page or Reel cap is a planned stop, not proof that every recent Reel was found. The run report says so (`discovery_complete`, `stop_reason`).

Exit codes: **0** done, **2** partial or failed, **75** another collector is running, **130** interrupted, **1** setup error.

## Storage

`data/history.sqlite` (folder 0700, files 0600, not encrypted, keep it on local disk). Each Reel's numbers save in one transaction, so a later failure keeps earlier Reels. Rate-limit answers stop the run with no automatic retries. A separate SQLite lock keeps two collectors from writing at once, and the operating system releases it if a process dies.

Every snapshot keeps its native value and unit, the period Meta returned, the API version, and any error. A failed value is null; a real zero stays zero. Tokens are never written to the database.

## MCP tools

| Tool | Reads | What |
| --- | --- | --- |
| `instagram_connection_status` | live | Is the sign-in working, and is it the expected account? |
| `instagram_list_recent_media` | live | Recent media, newest first |
| `instagram_get_reel_insights` | live | Insights for one owned Reel |
| `instagram_get_metric_history` | local DB | Saved snapshots for one Reel, newest first, with paging |
| `instagram_compare_snapshots` | local DB | Safe difference between two snapshots of one metric |

The history tools open SQLite read-only and never call Meta. A comparison is only calculated for lifetime counters with matching units, periods and API versions. Reach and average watch time return both values without subtracting them, because the difference would not mean anything.
