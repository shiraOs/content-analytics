// Test helper: builds a small .xlsx (or .zip) in memory, so tests never need a real export file.
// Cells are written as shared strings (like LinkedIn and TikTok do) unless they are numbers.
import { crc32, deflateRawSync } from 'node:zlib';
import type { Cell } from './sheet.ts';

export function zip(files: Record<string, Buffer | string>, compress = true): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const body = compress ? deflateRawSync(data) : data;
    const n = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(compress ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data) >>> 0, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(compress ? 8 : 0, 10);
    dir.writeUInt32LE(crc32(data) >>> 0, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    locals.push(local, n, body); central.push(dir, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const col = (i: number) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };

export function xlsx(sheets: Record<string, Cell[][]>): Buffer {
  const shared: string[] = [];
  const si = (s: string) => { let i = shared.indexOf(s); if (i < 0) { shared.push(s); i = shared.length - 1; } return i; };
  const names = Object.keys(sheets);
  const parts: Record<string, string> = {};
  names.forEach((name, n) => {
    const rows = sheets[name].map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => c === null ? '' : typeof c === 'number'
      ? `<c r="${col(ci)}${ri + 1}"><v>${c}</v></c>` : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(String(c))}</v></c>`).join('')}</row>`).join('');
    parts[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  });
  parts['xl/workbook.xml'] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${
    names.map((name, n) => `<sheet name="${esc(name)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join('')}</sheets></workbook>`;
  parts['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    names.map((_, n) => `<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join('')}</Relationships>`;
  parts['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  parts['[Content_Types].xml'] = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  return zip(parts);
}

// Consecutive dates as month/day/year or as TikTok's "November 12" labels.
export function days(from: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => new Date(Date.parse(from + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));
}
export const mdy = (iso: string) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthLabel = (iso: string) => `${months[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;

// A LinkedIn AggregateAnalytics workbook shaped like the real one (November 2026).
export function linkedinWorkbook(o: { start: string; end: string; impressions: (d: string) => string | number; engagements?: (d: string) => string;
  newFollowers?: (d: string) => string; followers: number; recent?: Cell[][]; top?: Cell[][] }): Buffer {
  const ds = days(o.start, Math.round((Date.parse(o.end) - Date.parse(o.start)) / 86400000) + 1);
  return xlsx({
    DISCOVERY: [['Overall Performance', `${mdy(o.start)} - ${mdy(o.end)}`], ['Impressions', '1000'], ['Members reached', '400']],
    ENGAGEMENT: [['Date', 'Impressions', 'Engagements'], ...ds.map(d => [mdy(d), String(o.impressions(d)), o.engagements ? o.engagements(d) : '1'])],
    'MOST RECENT POSTS': [['Post URL', 'Post Publish Date', 'Post type', 'Impressions', 'Impressions (in-network)', 'Impressions (out-of-network)', 'Members reached',
      'Followers gained', 'Profile viewers', 'Reactions', 'Comments', 'Reposts', 'Saves', 'Sends', 'Custom button engagements'], ...(o.recent ?? [])],
    'TOP POSTS': [['Maximum of 50 posts available to include in this list'], ['Post URL', 'Post Publish Date', 'Engagements', '', 'Post URL', 'Post Publish Date', 'Impressions'], [], ...(o.top ?? [])],
    FOLLOWERS: [[`Total followers on ${mdy(o.end)}`, String(o.followers)], ['Date', 'New followers'], [], ...ds.map(d => [mdy(d), o.newFollowers ? o.newFollowers(d) : '0'])],
    'AUDIENCE DEMOGRAPHICS': [['Top Demographics', 'Value', 'Percentage'], ['Location', 'Tel Aviv-Yafo', '17%']]
  });
}
