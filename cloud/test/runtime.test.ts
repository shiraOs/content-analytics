// Things the Workers runtime refuses that Node accepts, so the unit tests alone would not catch them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const files = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(`${dir}${e.name}/`) : e.name.endsWith('.ts') ? [`${dir}${e.name}`] : []);
test('no fetch uses redirect "error" (Workers throw on it; use "manual")', () => {
  for (const f of files('../src/')) assert.doesNotMatch(readFileSync(new URL(f, import.meta.url), 'utf8'), /redirect:\s*'error'/, f);
});

// Every outgoing request must set redirect: 'manual'. Leaving it out makes fetch follow a redirect to any host,
// so a request could end up somewhere outside the fixed list of API hosts.
const calls = (src: string): string[] => {
  const out: string[] = [];
  for (const m of src.matchAll(/(?<!async )\b(?:deps\.)?fetch\(|\bf\('https:/g)) {
    let depth = 0, i = m.index! + m[0].indexOf('(');
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    out.push(src.slice(m.index!, i + 1));
  }
  return out;
};
test('every outgoing request sets redirect "manual"', () => {
  let found = 0;
  for (const f of files('../src/')) {
    for (const call of calls(readFileSync(new URL(f, import.meta.url), 'utf8'))) {
      found++;
      assert.match(call, /redirect:\s*'manual'/, `${f}: ${call.slice(0, 80)}`);
    }
  }
  assert.ok(found >= 9, `expected to find the API requests, found ${found}`);
});
