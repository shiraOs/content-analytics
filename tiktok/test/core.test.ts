import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, status } from '../src/core.ts';

test('redact keeps TikTok error.code so a successful answer still reads as available', () => {
  const body = redact({ data: { user: { open_id: 'x' } }, error: { code: 'ok', message: '', log_id: 'L' }, refresh_token: 'r' }, ['tok']);
  assert.equal(body.error.code, 'ok');
  assert.equal(body.refresh_token, '[REDACTED]');
  assert.equal(status({ retrieved_at: '', endpoint: 'user/info/', http_status: 200, body }), 'available');
});
