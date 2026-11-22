// npm run import — reads every new LinkedIn analytics download in data/export into data/history.sqlite
// and moves it to data/export/imported/<today>/. To also send it to the cloud for the Sunday report,
// use `npm run import:exports` in ../cloud instead (it runs this, then copies the new rows to D1).
import { fileURLToPath } from 'node:url';
import { importFolder, report } from '../../shared/import-run.ts';
import { parseFile } from './parse.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const importLinkedIn = (at?: Date) => importFolder({ root, parse: parseFile, at });

if (import.meta.main) {
  const results = importLinkedIn();
  console.log(report('LinkedIn', results));
  if (results.some(r => r.status === 'failed')) process.exitCode = 2;
}
