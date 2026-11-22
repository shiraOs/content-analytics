// npm run import:export — reads every new TikTok Studio download in data/export (Overview, Viewers,
// FollowerHistory, Content) into the export tables of data/history.sqlite and moves the files to
// data/export/imported/<today>/. Files older than 30 days are refused, because TikTok's dates have no
// year and the year is worked out from the download time. To also send them to the cloud, use
// `npm run import:exports` in ../cloud.
import { importFolder, report } from '../../shared/import-run.ts';
import { root } from './core.ts';
import { parseFile } from './export.ts';

export const importTikTokExports = (at?: Date) => importFolder({ root, parse: p => parseFile(p), maxAgeDays: 30, at });

if (import.meta.main) {
  const results = importTikTokExports();
  console.log(report('TikTok Studio', results));
  if (results.some(r => r.status === 'failed')) process.exitCode = 2;
}
