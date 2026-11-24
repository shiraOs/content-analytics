# Cloud collector (Cloudflare Worker)

Runs the weekly YouTube, Instagram, TikTok and website collection on Cloudflare, with no laptop needed. It also holds the LinkedIn and TikTok Studio numbers that come from downloaded files. It is a port of `../youtube`, `../instagram` and `../tiktok` with the same rules: read-only, native units and windows, missing is never zero, no retries on quota or rate limits, and each step saves on its own.

- **When:** cron `*/5 5-6 * * SUN` (every 5 minutes, Sundays 05:00–06:55 UTC). The Workers Free plan allows 50 outside calls per run, so each run does one piece and stops: YouTube, then TikTok, then the Instagram listing, then Instagram Reels 5 at a time, then the website. Progress and a 10-minute lease live in each database's `cloud_jobs` table.
- **Data:** one D1 database per source (`content-youtube`, `content-instagram`, `content-tiktok`, `content-linkedin`, `content-site`), with the same table layouts as the local collectors, plus `cloud_jobs` and `credential_state`.
- **Downloads (no API):** LinkedIn's personal-profile analytics API is open only to vetted registered organizations, and TikTok Studio's profile numbers are not in the API. Both arrive only through `npm run import:exports`, which reads the downloaded files and sends only new ones to D1. No cron job touches them.
- **Sign-ins:** Worker secrets `YOUTUBE_CLIENT`, `YOUTUBE_CREDENTIAL`, `INSTAGRAM_CREDENTIAL`, `TIKTOK_CLIENT`, `TIKTOK_CREDENTIAL`, `DIGEST_KEY`. Google and TikTok access tokens are fetched fresh every run. A rotated TikTok refresh token and a renewed Instagram token are stored in D1 `credential_state`; whichever was saved last wins.
- **Endpoints** (header `Authorization: Bearer <DIGEST_KEY>`): `GET /digest` returns the weekly digest as JSON, with a `cloud` section for job status, sign-in expiry and problems. `POST /run` does one piece now, like a cron run.

## Website numbers

`src/site/` collects, in pieces: **traffic** (Cloudflare Web Analytics GraphQL + Bing Webmaster), **google** (Search Console Search Analytics and sitemaps, GA4 Data API), then **index** (Search Console URL Inspection for every sitemap URL, 40 per piece). Values go to the `content-site` database. The site job is skipped while `SITE_DB` is not bound.

- Which site: the `vars` in `wrangler.jsonc` (`SITE_HOST`, `SITE_CF_ACCOUNT_ID`, `SITE_CF_SITE_TAG`, `SITE_GA4_PROPERTY`, and optional `SITE_BIO_PATHS` for "link in bio" pages such as `/ig/`). None are secret.
- Secrets: `SITE_CF_TOKEN` (Account Analytics: Read only), `SITE_GOOGLE_CREDENTIAL` (from `npm run auth` in `../site`), `SITE_BING_KEY` (Bing has no read-only key, so only `Get*` methods are called, and the key is never logged or stored).
- Cloudflare samples Web Analytics and GA4 counts only visitors who accepted cookies, so the two are never added or compared.

## Set up

1. Create the D1 databases (`npx wrangler d1 create content-youtube`, and so on) and put their IDs in `wrangler.jsonc`.
2. Fill in the `vars` in `wrangler.jsonc`: `INSTAGRAM_USERNAME` (the Worker stops if the token belongs to another account) and the site vars, or remove the `SITE_DB` binding.
3. Sign in locally in each platform folder (`npm run auth`), then copy the sign-ins to Worker secrets with `npm run secrets`.

## Commands

```sh
npm test                 # node:test on a node:sqlite stand-in for D1
npm run typecheck
npm run dev              # wrangler dev --test-scheduled; then GET /__scheduled to fire the cron locally
npm run deploy
npm run schema -- --remote            # create tables (safe to repeat)
npm run import:history -- --remote    # copy local history.sqlite files in (safe to repeat)
npm run secrets                       # copy local sign-ins into Worker secrets, never printed
npm run import:exports                # new LinkedIn / TikTok Studio downloads -> local history -> D1
```

## When something breaks

- `authentication_failed` or `not_configured` for a platform: sign in again locally (`npm run auth` in that folder), then `npm run secrets` here.
- Workers reject `fetch(..., { redirect: 'error' })`, so the port uses `'manual'` and counts a redirect as a failure. A test guards this.
- Each cron run logs its piece and result, never tokens.
