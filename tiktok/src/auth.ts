import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { oauthClient, postToken, saveCredential, scopes, authorizeUrl, challenge, request, status, errorSummary, userFields, tokenSource } from './core.ts';

// Loopback sign-in for a TikTok Login Kit desktop app. You sign in in your own browser;
// tokens are never printed. Only the refresh token is saved (0600).
// The app's redirect URI in the developer portal must be exactly http://127.0.0.1:*/callback/
try {
  const client = await oauthClient();
  const verifier = randomBytes(48).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const redirect = `http://127.0.0.1:${port}/callback/`;
  const url = new URL(authorizeUrl);
  for (const [k, v] of Object.entries({ client_key: client.client_key, redirect_uri: redirect, response_type: 'code',
    scope: scopes.join(','), state, code_challenge: challenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(k, v);

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
    console.log('Opening TikTok sign-in in your browser. If it does not open, paste this link into your browser:\n\n' + url.href + '\n');
    spawn('open', [url.href], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }).finally(() => server.close());

  const r = await postToken({ ...client, code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
  if (typeof r.body.refresh_token !== 'string' || typeof r.body.access_token !== 'string')
    throw new Error(`TikTok did not return a sign-in (${String(r.body.error ?? 'unknown error')}). Check the app keys and redirect URI, then run npm run auth again.`);
  const granted = String(r.body.scope ?? '').split(',').map(s => s.trim());
  const missing = scopes.filter(s => !granted.includes(s));
  if (missing.length) throw new Error(`All four permissions are needed; missing: ${missing.join(', ')}. Add them to the app in the developer portal, then run npm run auth again.`);

  const u = await request(r.body.access_token, 'user/info/', userFields);
  const user = u.body.data?.user;
  if (status(u) !== 'available' || !user?.open_id) throw new Error(`Signed in, but TikTok would not return the account (${JSON.stringify(errorSummary(u))}). Run npm run auth again.`);
  await saveCredential({ refresh_token: r.body.refresh_token, scope: granted, open_id: user.open_id, username: user.username ?? null,
    refresh_expires_at: Number(r.body.refresh_expires_in) ? new Date(Date.now() + Number(r.body.refresh_expires_in) * 1000).toISOString() : null,
    saved_at: new Date().toISOString() });
  // Prove the saved refresh token works on its own before reporting success.
  await tokenSource()();
  console.log(`Connected to @${user.username ?? user.display_name}. Sign-in saved privately (0600). Next: npm run collect`);
} catch (e) { console.error(e instanceof Error ? e.message : 'Sign-in failed.'); process.exitCode = 1; }
