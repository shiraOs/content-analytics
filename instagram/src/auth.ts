import { credentials, saveCredential } from './core.ts';

async function hiddenToken(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Run auth interactively in your own terminal. Piped input is disabled.');
  process.stdout.write('Paste your Meta dashboard Instagram token here (input hidden), then Enter: ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = () => { process.stdin.setRawMode(false); process.stdin.pause();
      process.stdin.off('data', onData); process.stdout.write('\n'); };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') { done(); reject(new Error('Canceled.')); return; }
        if (char === '\r' || char === '\n') { done(); resolve(value.trim()); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    process.stdin.on('data', onData);
  });
}

try {
  let command = process.argv[2];
  if (command && command !== 'refresh' && command !== 'refresh-if-due') throw new Error('Usage: npm run auth OR npm run refresh OR npm run refresh-if-due');
  if (command === 'refresh-if-due') {
    // Renew only when the token has 20 days or less left (or its expiry is unknown) and is at least
    // 24 hours old, which Meta requires. Safe to run every week.
    const c = await credentials();
    const left = c.expires_at ? (Date.parse(c.expires_at) - Date.now()) / 86400000 : null;
    const age = c.saved_at ? (Date.now() - Date.parse(c.saved_at)) / 3600000 : null;
    if (left !== null && left <= 0) throw new Error('Token already expired; refresh is no longer possible. Generate a new dashboard token and run npm run auth.');
    if (left !== null && left > 20) { console.log(`Token not due: ${Math.floor(left)} days left (expires ${c.expires_at}).`); process.exit(0); }
    if (age !== null && age < 24) { console.log('Token is under 24 hours old; Meta does not allow a refresh yet.'); process.exit(0); }
    command = 'refresh';
  }
  if (command === 'refresh') {
    const old = await credentials();
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', old.access_token);
    // Documented endpoint requires a query token. Never log the URL, response, or fetch error.
    let response: Response;
    try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(25000) }); }
    catch { throw new Error('Refresh network request failed. Existing credential preserved.'); }
    let body: any;
    try { body = await response.json(); } catch { throw new Error('Refresh returned non-JSON. Existing credential preserved.'); }
    if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(body.expires_in))
      throw new Error('Meta rejected refresh. Token must be unexpired and at least 24 hours old, with basic permission. Existing credential preserved.');
    await saveCredential({ access_token: body.access_token, source: 'refresh', saved_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + body.expires_in * 1000).toISOString(), expiry_source: 'Meta expires_in' });
    console.log('Refreshed token saved privately. Expiry:', new Date(Date.now() + body.expires_in * 1000).toISOString());
  } else {
    const token = await hiddenToken();
    if (!/^[A-Za-z0-9._~-]{20,}$/.test(token)) throw new Error('Token format rejected; copy only the token, without quotes.');
    await saveCredential({ access_token: token, source: 'Meta App Dashboard', saved_at: new Date().toISOString(),
      expires_at: null, expiry_source: 'Unknown issuance time; dashboard tokens last 60 days from generation.' });
    console.log('Token saved privately (0600). Run npm run fetch to validate actual access.');
  }
} catch (e) { console.error(e instanceof Error ? e.message : 'Credential operation failed.'); process.exitCode = 1; }
