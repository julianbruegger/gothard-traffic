#!/usr/bin/env node
// Condenses a phpMyAdmin CSV export of `gotthard_snapshots` (one ASTRA/DATEX
// reading every ~3 min) into compact per-day hourly queue lengths:
//
//   site/src/data/observed-days.json   — committed; consumed by src/lib/observed-model.ts
//
// The raw export (~25 MB) stays out of git (.gitignore). Re-run after each new
// export to refresh the forecast with the latest measured traffic:
//
//   node site/scripts/build-observed-days.mjs [path/to/gotthard_snapshots.csv]
//
// Export settings (phpMyAdmin → table gotthard_snapshots → Export → Custom):
// CSV, "Put columns names in the first row", NULL kept as NULL, UTF-8.
//
// Cleaning applied before aggregation:
//  1. Stale reports: ASTRA often leaves a 1 km "Verkehrsüberlastung" message at
//     the Airolo portal active overnight after the afternoon jam has cleared —
//     the same 1 km reading then sits unchanged for 12–34 h. A ≤1 km reading
//     that has not changed for more than STALE_AFTER_MIN is zeroed.
//  2. Incident closures (Pannenfahrzeug, Brand, Unfall …): readings taken while
//     the bore is shut for an incident are excluded — those queues are real but
//     random, not part of the recurring pattern the forecast learns. Planned
//     roadworks ("Baustelle") are NOT treated as incidents: the collector flags
//     the whole multi-week campaign as "closed" around the clock even though the
//     bore only shuts at night, so that status is not trustworthy.
//
// Bucketing: Europe/Zurich local time, each reading assigned to the NEAREST full
// hour (so hour h covers h−0:30 … h+0:29), which is how forecast.ts samples its
// hourly profiles (value at hh:00).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(process.argv[2] ?? resolve(REPO_ROOT, 'gotthard_snapshots.csv'));
const OUT = resolve(__dirname, '..', 'src', 'data', 'observed-days.json');

const STALE_AFTER_MIN = 120;
const STALE_MAX_KM = 1;

// ─── CSV ───────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
      wasQuoted = true;
    } else if (ch === ',') {
      row.push(wasQuoted ? field : field === 'NULL' ? null : field);
      field = ''; wasQuoted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(wasQuoted ? field : field === 'NULL' ? null : field);
      if (row.length > 1 || row[0]) rows.push(row);
      row = []; field = ''; wasQuoted = false;
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(wasQuoted ? field : field === 'NULL' ? null : field);
    rows.push(row);
  }
  return rows;
}

const [header, ...body] = parseCsv(readFileSync(SRC, 'utf8'));
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['fetched_at', 'tunnel_status', 'closure_reason', 'north_queue_km', 'south_queue_km']) {
  if (!(need in col)) throw new Error(`CSV is missing column "${need}" — is this a gotthard_snapshots export?`);
}

const num = (v) => (v == null || v === '' ? 0 : +v);
const readings = body
  .map((r) => ({
    t: Date.parse(r[col.fetched_at].replace(' ', 'T') + 'Z'), // DB stores UTC
    status: r[col.tunnel_status],
    reason: r[col.closure_reason] ?? '',
    N: num(r[col.north_queue_km]),
    S: num(r[col.south_queue_km]),
  }))
  .filter((r) => Number.isFinite(r.t))
  .sort((a, b) => a.t - b.t);

// ─── Cleaning ──────────────────────────────────────────────────────────────────

let staleZeroed = 0;
for (const dir of ['N', 'S']) {
  const orig = readings.map((r) => r[dir]); // run detection must see the unzeroed values
  let runStart = 0;
  for (let i = 0; i < readings.length; i++) {
    if (i > 0 && orig[i] !== orig[i - 1]) runStart = i;
    const r = readings[i];
    if (r[dir] > 0 && r[dir] <= STALE_MAX_KM && r.t - readings[runStart].t > STALE_AFTER_MIN * 60_000) {
      r[dir] = 0;
      staleZeroed++;
    }
  }
}

const isIncident = (r) => r.status === 'closed' && r.reason !== '' && !/baustelle/i.test(r.reason);
const incidentExcluded = readings.filter(isIncident).length;

// ─── Hourly aggregation (Swiss local, nearest hour) ───────────────────────────

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});
function swissHourKey(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms + 30 * 60_000)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}

const acc = new Map(); // day → { N: sum[24], S: sum[24], n: count[24] }
for (const r of readings) {
  if (isIncident(r)) continue;
  const { day, hour } = swissHourKey(r.t);
  let d = acc.get(day);
  if (!d) acc.set(day, (d = { N: new Array(24).fill(0), S: new Array(24).fill(0), n: new Array(24).fill(0) }));
  d.N[hour] += r.N;
  d.S[hour] += r.S;
  d.n[hour]++;
}

// An hour needs a few readings to count (cron runs every ~3 min → ~20/hour).
const MIN_READINGS_PER_HOUR = 5;
// A day needs most of its hours, otherwise its daily level is unreliable.
const MIN_HOURS_PER_DAY = 18;

const days = [...acc.entries()]
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([d, v]) => {
    const hourly = (dir) =>
      v.n.map((cnt, h) => (cnt >= MIN_READINGS_PER_HOUR ? +(v[dir][h] / cnt).toFixed(2) : null));
    return { d, n: hourly('N'), s: hourly('S') };
  })
  .filter((day) => day.n.filter((x) => x !== null).length >= MIN_HOURS_PER_DAY);

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'gotthard_snapshots (ASTRA DATEX II via opentransportdata.swiss), phpMyAdmin CSV export',
    firstReading: new Date(readings[0].t).toISOString(),
    lastReading: new Date(readings.at(-1).t).toISOString(),
    readings: readings.length,
    staleReadingsZeroed: staleZeroed,
    incidentReadingsExcluded: incidentExcluded,
    note: 'Mean queue km per Swiss-local hour (nearest-hour buckets). n = Nordportal Göschenen (southbound), s = Südportal Airolo (northbound). ASTRA delay = 10 min per km. null = too few readings.',
  },
  days,
};

writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(`Read ${readings.length} readings (${out.meta.firstReading} → ${out.meta.lastReading})`);
console.log(`Zeroed ${staleZeroed} stale ≤${STALE_MAX_KM} km readings, excluded ${incidentExcluded} incident-closure readings`);
console.log(`Wrote ${days.length} days to ${OUT}`);
