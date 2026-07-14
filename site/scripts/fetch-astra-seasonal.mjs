#!/usr/bin/env node
/**
 * Builds a real seasonal traffic profile for the Gotthard tunnel from official
 * ASTRA data (Swiss Automatic Road Traffic Counts / SASVZ), counting station
 * 150 "GOTTHARDTUNNEL" on the A2.
 *
 * ASTRA publishes one annual bulletin per year — an .xlsx with an "ADT" sheet
 * giving each station's Average Daily Traffic per month (both directions). We
 * pull several years, extract station 150's 12 monthly volumes, average them,
 * and write a normalised seasonal profile that forecast.ts uses instead of a
 * hand-tuned SEASON curve.
 *
 * Run once (re-run to refresh / add a year):
 *   npm run fetch:seasonal
 *
 * Then commit site/src/data/astra-seasonal.json. No API token, no scraping —
 * these are public federal open-data files.
 *
 * If a URL 404s in a future year, grab the new annual bulletin link from
 * https://www.astra.admin.ch/.../annual-and-monthly-results.html and add it
 * to BULLETINS below (the dam/<id> path changes each year).
 */

import { inflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir   = dirname(fileURLToPath(import.meta.url));
const outDir  = join(__dir, '../src/data');
const outPath = join(outDir, 'astra-seasonal.json');

const STATION = { id: '150', name: 'GOTTHARDTUNNEL' };

// Official ASTRA annual bulletins (public open data). dam/<id> changes yearly.
const BULLETINS = {
  2023: 'https://www.astra.admin.ch/dam/en/sd-web/z6BJ81AzKCJQ/jahresergebnisse_2023.xlsx',
  2024: 'https://www.astra.admin.ch/dam/en/sd-web/szrohDjQVjAZ/jahres-ergebnisse-2024.xlsx',
  2025: 'https://www.astra.admin.ch/dam/en/sd-web/iS7VWufuwjEJ/Bulletin_2025_en.xlsx',
};

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─── Minimal ZIP reader (xlsx is a ZIP of XML parts) ─────────────────────────
// Reads entries via the central directory so we don't depend on data-descriptor
// quirks. Only the parts we need are inflated.

function readZipEntries(buf, wanted) {
  // Locate End Of Central Directory record (signature 0x06054b50).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid zip (no EOCD)');

  const count     = buf.readUInt16LE(eocd + 10);
  let   ptr       = buf.readUInt32LE(eocd + 16); // central dir offset
  const out       = {};

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // central dir header
    const method   = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen  = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const cmtLen   = buf.readUInt16LE(ptr + 32);
    const lhOffset = buf.readUInt32LE(ptr + 42);
    const name     = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + cmtLen;

    if (!wanted(name)) continue;

    // Jump to the local file header to find the real data offset.
    const lhNameLen  = buf.readUInt16LE(lhOffset + 26);
    const lhExtraLen = buf.readUInt16LE(lhOffset + 28);
    const dataStart  = lhOffset + 30 + lhNameLen + lhExtraLen;
    const raw        = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? raw : inflateRawSync(raw);
  }
  return out; // { name: Buffer }
}

// ─── xlsx sheet parsing ──────────────────────────────────────────────────────

function colToNum(ref) {
  const c = ref.match(/[A-Z]+/)[0];
  let n = 0;
  for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  return [...xml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join(''),
  );
}

function parseSheet(xml, strings) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/gs)) {
      const ci = colToNum(cm[1]);
      const vm = cm[3].match(/<v>([^<]*)<\/v>/);
      let val = '';
      if (vm) { val = vm[1]; if (/t="s"/.test(cm[2])) val = strings[+val] ?? val; }
      cells[ci] = val;
    }
    rows.push(cells);
  }
  return rows;
}

/** Extract station 150's 12 monthly ADT values from one bulletin buffer. */
function extractMonthlyADT(xlsxBuf) {
  const parts   = readZipEntries(xlsxBuf, (n) =>
    n === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const strings = parseSharedStrings(parts['xl/sharedStrings.xml'].toString('utf8'));

  for (const name of Object.keys(parts)) {
    if (!name.startsWith('xl/worksheets/')) continue;
    const rows = parseSheet(parts[name].toString('utf8'), strings);
    // Station rows: col 0 = station id, col 1 = name, col 5 = metric ("ADT"),
    // cols 6..17 = Jan..Dec average daily traffic.
    const row = rows.find((r) =>
      String(r[0]) === STATION.id &&
      String(r[1]).includes(STATION.name) &&
      String(r[5]).includes('ADT'));
    if (row) {
      const months = [];
      for (let c = 6; c <= 17; c++) months.push(Math.round(Number(row[c])));
      if (months.every((v) => Number.isFinite(v) && v > 0)) return months;
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const perYear = {};
  for (const [year, url] of Object.entries(BULLETINS)) {
    process.stdout.write(`${year}: fetching … `);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (gotthard-traffic seasonal ingest)' },
    });
    if (!res.ok) { console.log(`HTTP ${res.status} — skipped`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    const months = extractMonthlyADT(buf);
    if (!months) { console.log('station 150 not found — skipped'); continue; }
    perYear[year] = months;
    console.log(`ok  [${months.join(', ')}]`);
  }

  const years = Object.keys(perYear);
  if (years.length === 0) throw new Error('No bulletins parsed — check BULLETINS URLs.');

  // Average each month across the available years.
  const avg = MONTHS.map((_, m) =>
    Math.round(years.reduce((s, y) => s + perYear[y][m], 0) / years.length));

  const peak = Math.max(...avg);
  // Normalised volume ratio, 0..1 (Aug ≈ 1.0, winter ≈ 0.5).
  const volumeRatio = avg.map((v) => +(v / peak).toFixed(3));

  const out = {
    generated: new Date().toISOString(),
    source: 'ASTRA SASVZ annual bulletins (station 150 GOTTHARDTUNNEL, A2)',
    station: STATION,
    metric: 'ADT — average daily traffic, both directions (vehicles/day)',
    months: MONTHS,
    years: perYear,
    avgDailyTraffic: avg,
    volumeRatio,
    note: 'volumeRatio is normalised vehicle volume, NOT congestion. forecast.ts '
        + 'raises it to SEASON_EXPONENT to approximate the (super-linear) jam risk.',
  };

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log(`\nyears used: ${years.join(', ')}`);
  console.log('avg ADT :', MONTHS.map((mo, i) => `${mo} ${avg[i]}`).join('  '));
  console.log('ratio   :', MONTHS.map((mo, i) => `${mo} ${volumeRatio[i]}`).join('  '));
  console.log(`\nWrote ${outPath}`);
}

main().catch((err) => { console.error('[fatal]', err.message); process.exit(1); });
