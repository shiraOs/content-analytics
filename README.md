# content-analytics

I make short tech videos for Instagram, TikTok, YouTube and LinkedIn. Every Sunday I want one report with how each video did and how my website did. This project collects those numbers, keeps their history, and builds that weekly report.

It runs on its own every Sunday on Cloudflare Workers (free plan), and each platform also has a local command-line tool. Two of the platforms also come with a small MCP server, so an AI assistant like Claude can read the numbers without ever seeing a token.

## What it reads

| Source | How | Folder |
| --- | --- | --- |
| YouTube | Data API v3 + Analytics API, Google OAuth (read-only scopes) | `youtube/` |
| Instagram | Instagram API with Instagram Login (account and Reel insights) | `instagram/` |
| TikTok | Login Kit + Display API (`user.info.*`, `video.list`) | `tiktok/` |
| TikTok Studio | Files downloaded from TikTok Studio (no API for these numbers) | `tiktok/` |
| LinkedIn | Files downloaded from LinkedIn analytics (no API for personal profiles) | `linkedin/` |
| Website | Cloudflare Web Analytics, Search Console, Google Analytics 4, Bing Webmaster | `site/`, `cloud/src/site/` |

## How it fits together

```
 YouTube / Instagram / TikTok / website APIs
                 |
                 v
   cloud/  Cloudflare Worker, cron every 5 min on Sunday morning
           one small piece per run (free plan = 50 outside calls per run)
                 |
                 v
   D1 databases (one per source): dated snapshots, never overwritten
                 ^                                  |
                 |                                  v
   linkedin/, tiktok/  import downloaded       GET /digest  ->  weekly report (JSON)
   files from a laptop (npm run import:exports)
```

Each platform folder also works on its own on a laptop: sign in, collect into a local SQLite file, and read it back. The Worker is a port of those same collectors.

## Rules the code follows

- **Read-only.** Only read scopes are requested. Nothing can post, edit or delete.
- **Missing is not zero.** If a platform does not return a number, it is stored as missing, never as 0. A real 0 stays 0.
- **Keep the platform's own units and windows.** A "lifetime" count and a "last 7 days" count are never mixed, and averages are never subtracted.
- **No retry storms.** A quota or rate-limit answer stops the run. The next run picks up where it left off.
- **Each step saves on its own.** If step 4 fails, steps 1 to 3 are kept.
- **Secrets stay out of the numbers.** Tokens live in Worker secrets or in 0600 local files that git ignores. They are never logged, never saved next to the numbers, and never returned by the MCP tools. The one exception: when Instagram renews a token or TikTok rotates one, the Worker keeps the new token in its own `credential_state` table in D1, because Worker secrets can't be changed from inside the Worker. Tests check this.
- **Downloaded files are untrusted.** The spreadsheet reader has no dependencies, never evaluates formulas, and caps file sizes.

## Run it

Needs Node 22.18 or newer (the TypeScript runs directly with Node's type stripping). Each folder is its own package:

```sh
cd youtube        # or instagram, tiktok, linkedin, cloud
npm ci
npm test
npm run typecheck
```

To run it for your own accounts, you need your own developer apps (a Google Cloud OAuth client, a Meta app, a TikTok app) and a Cloudflare account. Each folder's README explains its sign-in. `cloud/README.md` explains the Worker set up, and `cloud/wrangler.jsonc` shows every setting to fill in.

## Layout

```
cloud/      Cloudflare Worker: cron jobs, D1 schema, weekly digest, import scripts
youtube/    YouTube CLI, collector, MCP server, and the local weekly digest
            (reads the YouTube, Instagram and TikTok history on the laptop)
instagram/  Instagram CLI, collector, MCP server, and an import for older saved API answers
tiktok/     TikTok sign-in, collector, TikTok Studio file import
linkedin/   LinkedIn analytics file import
site/       Website sign-in and a live check (the collection runs in cloud/)
shared/     Code LinkedIn and TikTok share for downloaded files: a spreadsheet reader
            (.xlsx, .csv, .zip), the database tables for their numbers, and an import
            that reads each new file once, then moves it to an "imported" folder
```

## License

MIT. See [LICENSE](LICENSE).
