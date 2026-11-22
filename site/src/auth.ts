// One-time Google sign-in for Search Console + Google Analytics (read-only), like ../youtube/src/auth.ts.
// You sign in in your own browser; tokens are never printed. Only the refresh token is saved (0600).
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { oauthClient, postToken, saveCredential, scopes, accessToken, getJson } from './google.ts';

const b64 = (b: Buffer) => b.toString('base64url');

try {
  const client = await oauthClient();
  const verifier = b64(randomBytes(32));
  const state = b64(randomBytes(16));
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for (const [k, v] of Object.entries({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code',
    scope: scopes.join(' '), access_type: 'offline', prompt: 'consent', state,
    code_challenge: b64(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' })) url.searchParams.set(k, v);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in timed out after 5 minutes. Run npm run auth again.')), 300000);
    server.on('request', (req, res) => {
      const q = new URL(req.url ?? '/', redirect).searchParams;
      if (!q.has('code') && !q.has('error')) { res.writeHead(404).end(); return; }
      const ok = q.get('state') === state && q.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(ok ? '<p>Signed in. You can close this tab and go back to Claude.</p>' : '<p>Sign-in did not complete. Go back to the terminal.</p>');
      clearTimeout(timer);
      if (ok) resolve(q.get('code')!);
      else reject(new Error(q.get('error') === 'access_denied' ? 'Sign-in was canceled.' : 'Sign-in failed (state mismatch or missing code).'));
    });
    console.log('Opening Google sign-in in your browser. If it does not open, paste this link into your browser:\n\n' + url.href + '\n');
    spawn('open', [url.href], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }).finally(() => server.close());

  const r = await postToken({ ...client, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
  if (typeof r.body.refresh_token !== 'string') throw new Error('Google did not return a long-lived sign-in. Remove this app at myaccount.google.com/connections and run npm run auth again.');
  const granted = String(r.body.scope ?? '').split(' ');
  if (scopes.some(s => !granted.includes(s))) throw new Error('Both read-only permissions are needed (Search Console and Google Analytics). Run npm run auth again and tick both boxes.');
  await saveCredential({ refresh_token: r.body.refresh_token, scope: granted, saved_at: new Date().toISOString() });

  // Prove the saved sign-in works on its own, then check the Search Console property is visible.
  const token = await accessToken();
  const sites = await getJson(token, 'https://www.googleapis.com/webmasters/v3/sites');
  const list: string[] = (sites.body.siteEntry ?? []).map((s: any) => s.siteUrl);
  console.log('Sign-in saved privately (0600).');
  const want = `sc-domain:${process.env.SITE_HOST ?? 'example.com'}`;
  console.log(list.includes(want)
    ? `Search Console: ${want} is visible.`
    : `Search Console: ${want} NOT visible (HTTP ${sites.http_status}). Was the right Google account picked?`);
} catch (e) { console.error(e instanceof Error ? e.message : 'Sign-in failed.'); process.exitCode = 1; }
