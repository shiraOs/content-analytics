# Site sign-in

Local sign-ins for the site numbers. The collection itself runs in `../cloud` (`src/site/`).

| File | What |
| --- | --- |
| `.env.cloudflare-token` | Cloudflare profile API token, **Account Analytics: Read** only, one account. 0600, git-ignored. |
| `.credentials.json` | Google refresh token from `npm run auth` (Search Console `webmasters.readonly` + Google Analytics `analytics.readonly`). Uses the Desktop client in `../youtube/.client.json`; the YouTube sign-in is separate and untouched. 0600, git-ignored. |
| `.env.bing-key` | Bing Webmaster API key (Settings → API access). Bing offers no read-only key. 0600, git-ignored. |

```sh
npm run auth                # Google sign-in with the account that owns Search Console + GA4
SITE_HOST=example.com node src/check.ts <GA4 property ID> # live check: Search Console, URL Inspection, GA4 (prints numbers only)
cd ../cloud && npm run secrets -- SITE_CF_TOKEN SITE_GOOGLE_CREDENTIAL SITE_BING_KEY
```

On a Mac, save a new token or key from the clipboard without it showing on screen:

```sh
(umask 077; pbpaste | tr -cd 'A-Za-z0-9_.-' > .env.cloudflare-token)
```
