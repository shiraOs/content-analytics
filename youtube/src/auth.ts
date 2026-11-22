import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { oauthClient, postToken, saveCredential, scopes, request, status, tokenSource } from './core.ts';

// Loopback sign-in for a Desktop-app OAuth client. You sign in in your own browser;
// tokens are never printed. Only the refresh token is saved (0600).
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
  if (typeof r.body.refresh_token !== 'string') throw new Error('Google did not return a long-lived sign-in. Remove the app at myaccount.google.com/permissions and run npm run auth again.');
  const granted = String(r.body.scope ?? '').split(' ');
  const missing = scopes.filter(s => !granted.includes(s));
  if (missing.length) throw new Error('Both read-only permissions are needed (YouTube and YouTube Analytics). Run npm run auth again and tick both boxes.');

  const token = r.body.access_token as string;
  const ch = await request(token, 'data', 'channels', { part: 'snippet', mine: 'true' });
  const item = ch.body.items?.[0];
  if (status(ch) !== 'available' || !item) throw new Error('Signed in, but no YouTube channel was found for that account. If the channel is on a Brand Account, run npm run auth again and pick the channel.');
  await saveCredential({ refresh_token: r.body.refresh_token, scope: granted, channel_id: item.id,
    channel_title: item.snippet?.title ?? null, saved_at: new Date().toISOString() });
  // Prove the saved refresh token works on its own before reporting success.
  await tokenSource()();
  console.log(`Connected to "${item.snippet?.title}" (${item.id}). Sign-in saved privately (0600). Next: npm run collect`);
} catch (e) { console.error(e instanceof Error ? e.message : 'Sign-in failed.'); process.exitCode = 1; }
