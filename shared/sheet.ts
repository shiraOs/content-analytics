// Reads the spreadsheets that LinkedIn and TikTok Studio let you download: .xlsx, .csv, or a .zip of those.
// No dependencies: a small ZIP reader on node:zlib and a tolerant XML scan of the sheet parts.
// Export files are untrusted data. Nothing is ever extracted to disk, formulas are never evaluated
// (only the cached value is read), and sizes are capped so a malformed file can't exhaust memory.
import { inflateRawSync } from 'node:zlib';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export type Cell = string | number | boolean | null;
export type Table = { file: string; sheet: string; rows: Cell[][] };

const MAX_FILE = 50 * 1024 * 1024;
const MAX_ENTRY = 64 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export class SheetError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

// ---------- ZIP ----------
type Entry = { name: string; method: number; compressed: number; size: number; offset: number };

export function zipEntries(buf: Buffer): Entry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SheetError('not_a_zip', 'The file is not a ZIP/XLSX archive.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new SheetError('zip64_unsupported', 'Very large (ZIP64) archives are not supported.');
  if (count > MAX_ENTRIES) throw new SheetError('too_many_entries', 'The archive has too many files.');
  const out: Entry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new SheetError('zip_corrupt', 'The archive directory is damaged.');
    const method = buf.readUInt16LE(p + 10), compressed = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compressed, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function zipRead(buf: Buffer, e: Entry, budget: { left: number }): Buffer {
  if (e.size > MAX_ENTRY || e.size > budget.left) throw new SheetError('too_large', `Part ${e.name} is too large.`);
  const p = e.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new SheetError('zip_corrupt', 'A file inside the archive is damaged.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressed);
  let out: Buffer;
  if (e.method === 0) out = Buffer.from(data);
  else if (e.method === 8) {
    try { out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) }); }
    catch { throw new SheetError('zip_corrupt', `Part ${e.name} could not be decompressed.`); }
  } else throw new SheetError('zip_method_unsupported', `Part ${e.name} uses an unsupported compression.`);
  budget.left -= out.length;
  return out;
}

// ---------- XML ----------
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : entities[e.toLowerCase()]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
// All <t> text inside a fragment (rich text runs join), skipping phonetic <rPh> runs.
const text = (xml: string) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)]
  .map(m => unescapeXml(m[1] ?? '')).join('');

export const columnIndex = (ref: string) => {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

function sheetRows(xml: string, shared: string[]): Cell[][] {
  const rows: Cell[][] = [];
  for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const r = Number(attr(rm[1] ?? rm[3] ?? '', 'r')) || rows.length + 1;
    const row: Cell[] = [];
    let col = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cm[1], body = cm[2] ?? '';
      const ref = attr(tag, 'r');
      if (ref) col = columnIndex(ref);
      const t = attr(tag, 't');
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value: Cell = null;
      if (t === 's') value = v !== undefined ? shared[Number(v)] ?? null : null;
      else if (t === 'inlineStr') value = text(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else if (t === 'str' || t === 'e') value = v !== undefined ? unescapeXml(v) : null;
      else if (t === 'b') value = v === '1';
      else if (v !== undefined && v !== '') { const num = Number(v); value = Number.isFinite(num) ? num : unescapeXml(v); }
      row[col] = value;
      col++;
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = null;
    while (rows.length < r - 1) rows.push([]);
    rows[r - 1] = row;
  }
  return rows;
}

export function readXlsx(buf: Buffer, file = 'workbook.xlsx'): Table[] {
  const entries = zipEntries(buf);
  const budget = { left: MAX_TOTAL };
  const byName = new Map(entries.map(e => [e.name.replace(/^\/+/, ''), e]));
  const part = (name: string) => { const e = byName.get(name); return e ? zipRead(buf, e, budget).toString('utf8') : null; };
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new SheetError('not_xlsx', 'This archive is not an Excel workbook.');
  const sharedXml = part('xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map(m => text(m[1] ?? '')) : [];
  const rels = part('xl/_rels/workbook.xml.rels') ?? '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const tables: Table[] = [];
  for (const sm of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescapeXml(attr(sm[0], 'name') ?? 'Sheet');
    let target = targets.get(attr(sm[0], 'r:id')) ?? '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    const xml = part(target);
    if (xml !== null) tables.push({ file, sheet: name, rows: sheetRows(xml, shared) });
  }
  return tables;
}

// ---------- CSV ----------
export function readCsv(textIn: string, file = 'data.csv'): Table {
  const s = textIn.replace(/^﻿/, '');
  const delimiter = (() => { const first = s.split(/\r?\n/, 1)[0] ?? ''; const c = (ch: string) => first.split(ch).length; return c(';') > c(',') ? ';' : c('\t') > c(',') ? '\t' : ','; })();
  const rows: Cell[][] = [];
  let row: Cell[] = [], field = '', quoted = false, i = 0, wasQuoted = false;
  const push = () => { row.push(wasQuoted ? field : field === '' ? null : field); field = ''; wasQuoted = false; };
  while (i < s.length) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { quoted = true; wasQuoted = true; i++; continue; }
    if (ch === delimiter) { push(); i++; continue; }
    if (ch === '\r' || ch === '\n') { push(); rows.push(row); row = []; i += ch === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    field += ch; i++;
  }
  if (field !== '' || wasQuoted || row.length) { push(); rows.push(row); }
  return { file, sheet: '', rows };
}

// ---------- any download ----------
// One .xlsx/.csv file, or a .zip holding several (TikTok Studio sometimes zips its sheets).
export function readTables(path: string): Table[] {
  const st = statSync(path);
  if (!st.isFile()) throw new SheetError('not_a_file', 'Not a file.');
  if (st.size > MAX_FILE) throw new SheetError('too_large', 'The file is larger than 50 MB; that is not an analytics export.');
  const buf = readFileSync(path);
  return readBuffer(buf, basename(path));
}

export function readBuffer(buf: Buffer, file: string): Table[] {
  const lower = file.toLowerCase();
  if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return [readCsv(buf.toString('utf8'), file)];
  if (lower.endsWith('.xlsx')) return readXlsx(buf, file);
  if (lower.endsWith('.zip')) {
    const budget = { left: MAX_TOTAL };
    const out: Table[] = [];
    for (const e of zipEntries(buf)) {
      const name = e.name.split('/').pop() ?? '';
      if (!name || name.startsWith('.') || e.name.startsWith('__MACOSX/')) continue;
      if (!/\.(csv|tsv|xlsx)$/i.test(name)) continue;
      out.push(...readBuffer(zipRead(buf, e, budget), name));
    }
    return out;
  }
  throw new SheetError('unsupported_file', `Unsupported file type: ${file}. Expected .xlsx, .csv or .zip.`);
}

// ---------- values ----------
// Spreadsheet numbers arrive as numbers, "1,234", "1.2K", "12%", or "-" / "" for no data.
// Returns null when there is no number (missing is never zero).
export function toNumber(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/[ \s]/g, '');
  if (!s || /^(-|–|—|n\/a|na|null|none)$/i.test(s)) return null;
  const m = s.match(/^([+-]?)([\d,]*\.?\d+)([kKmM]?)(%?)$/);
  if (!m) return null;
  let n = Number(m[2].replace(/,/g, ''));
  if (m[3]) n *= m[3].toLowerCase() === 'k' ? 1e3 : 1e6;
  if (m[1] === '-') n = -n;
  return Number.isFinite(n) ? n : null;
}

// Excel stores dates as days since 1899-12-30. Strings like 11/12/2026 are month/day/year (LinkedIn, TikTok US export),
// 2026-11-12 is ISO. Returns YYYY-MM-DD or null.
export function toDate(v: Cell, order: 'mdy' | 'dmy' = 'mdy'): string | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const iso = (y: number, mo: number, d: number) => {
    const date = new Date(Date.UTC(y, mo - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
  };
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return order === 'mdy' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]); }
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && months.includes(m[1].toLowerCase())) return iso(+m[3], months.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  if (m && months.includes(m[2].toLowerCase())) return iso(+m[3], months.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  return null;
}

export const norm = (v: Cell) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// TikTok Studio writes dates as "November 12" with no year. Given the labels of consecutive days (oldest first)
// and the download time, gives each its full date: the newest label is the latest such day on or before the
// download, and every earlier row must be exactly one day before the next, or the file is rejected.
const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function monthDay(label: Cell): { m: number; d: number } | null {
  const s = norm(label).replace(/,/g, '');
  let mm = s.match(/^([a-z]+)\.?\s+(\d{1,2})$/);
  if (mm) { const m = monthNames.findIndex(n => n.startsWith(mm![1].slice(0, 3))); return m >= 0 ? { m: m + 1, d: +mm[2] } : null; }
  mm = s.match(/^(\d{1,2})\s+([a-z]+)\.?$/);
  if (mm) { const m = monthNames.findIndex(n => n.startsWith(mm![2].slice(0, 3))); return m >= 0 ? { m: m + 1, d: +mm[1] } : null; }
  return null;
}
export function latestOnOrBefore(md: { m: number; d: number }, ref: Date): string | null {
  for (let y = ref.getUTCFullYear(); y >= ref.getUTCFullYear() - 1; y--) {
    const t = Date.UTC(y, md.m - 1, md.d);
    const back = new Date(t);
    if (back.getUTCMonth() !== md.m - 1) return null;
    if (t <= Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())) return back.toISOString().slice(0, 10);
  }
  return null;
}
export function resolveConsecutive(labels: Cell[], ref: Date): string[] | null {
  if (!labels.length) return [];
  const last = monthDay(labels[labels.length - 1]);
  const end = last && latestOnOrBefore(last, ref);
  if (!end) return null;
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const iso = new Date(Date.parse(end) - (labels.length - 1 - i) * 86400000).toISOString().slice(0, 10);
    const md = monthDay(labels[i]);
    if (!md || +iso.slice(5, 7) !== md.m || +iso.slice(8, 10) !== md.d) return null;
    out.push(iso);
  }
  return out;
}
