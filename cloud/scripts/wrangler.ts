import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const databases = { youtube: 'content-youtube', instagram: 'content-instagram', tiktok: 'content-tiktok', linkedin: 'content-linkedin', site: 'content-site' } as const;
export type Platform = keyof typeof databases;

// Runs the project's own wrangler. Output is captured, never echoed, so a value piped in can't reach the screen.
export function wrangler(args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(root + 'node_modules/.bin/wrangler', args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code: code ?? 1, out, err }));
    child.stdin.end(input ?? '');
  });
}

export function target(argv: string[]): '--remote' | '--local' {
  if (argv.includes('--remote')) return '--remote';
  if (argv.includes('--local')) return '--local';
  throw new Error('Say where: --local (wrangler dev copy on this computer) or --remote (the real Cloudflare databases).');
}
