import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, redact, request, status } from '../src/core.ts';
import type { Result } from '../src/core.ts';

function response(body: any, http_status = 200): Result {
  return { body, http_status, retrieved_at: '2026-09-09T00:00:00Z', endpoint: 'test', parameters: {}, api_version_returned: null };
}
test('zero survives; empty or null data never becomes zero; returned period is preserved', () => {
  const zero = normalize('views', response({ data: [{ name: 'views', period: 'lifetime', values: [{ value: 0 }] }] }));
  assert.equal(zero.value, 0); assert.equal(zero.status, 'available'); assert.equal(zero.period, 'lifetime');
  for (const data of [[], [{ name: 'views', values: [{ value: null }] }]]) {
    const absent = normalize('views', response({ data }));
    assert.equal(absent.status, 'missing'); assert.equal(absent.value, null);
  }
  assert.equal(normalize('views', response({ data: [{ name: 'views', total_value: { value: 8 } }] })).value, 8);
});
test('permission, authentication, explicit unsupported, and ambiguous errors stay distinct', () => {
  assert.equal(status(response({ error: { code: 190 } }, 400)), 'authentication_failed');
  assert.equal(status(response({ error: { code: 10, message: 'Permission required' } }, 400)), 'permission_denied');
  assert.equal(status(response({ error: { code: 100, message: 'Unsupported metric' } }, 400)), 'unsupported');
  assert.equal(status(response({ error: { code: 100, message: 'Unsupported get request. Object may not exist or permissions missing.' } }, 400)), 'error');
  assert.equal(status(response({ error: { code: 10, message: 'Not enough viewers for the media to show insights' } }, 400)), 'missing');
});
test('response sanitization removes tokens from fields, errors, and paging URLs', () => {
  const clean = redact({ access_token: 'secret', error: { message: 'Token secret expired' },
    paging: { next: 'https://graph.instagram.com/x?access_token=secret&after=abc' } }, 'secret');
  assert.ok(!JSON.stringify(clean).includes('secret'));
  assert.ok(clean.paging.next.includes('after=abc'));
});
test('transport fixes host, uses bearer header, and sanitizes response (synthetic, not proof of API access)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url: any, init: any) => {
    assert.equal(url.hostname, 'graph.instagram.com');
    assert.equal(url.pathname, '/v25.0/me');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(init.headers.Authorization, 'Bearer fake-token');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ error: { code: 190, message: 'fake-token expired' } }), { status: 400 });
  };
  try {
    const result = await request('fake-token', 'me');
    assert.equal(status(result), 'authentication_failed');
    assert.ok(!JSON.stringify(result).includes('fake-token'));
  } finally { globalThis.fetch = original; }
});
