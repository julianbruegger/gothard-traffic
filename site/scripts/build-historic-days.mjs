#!/usr/bin/env node
// Derives per-day, per-direction congestion timeseries from the TCS Gotthard
// traffic-report history (tcs_gotthard_tweets.json) so real past days can be
// overlaid on the home-page wait-time prediction chart.
//
// Output: site/src/data/historic-days.json — consumed by
// site/src/lib/historic-days.ts.
//
// Usage: node site/scripts/build-historic-days.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(REPO_ROOT, 'tcs_gotthard_tweets.json');
const OUT = resolve(__dirname, '..', 'src', 'data', 'historic-days.json');

const dec = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

// Swiss local time. DST 2026 starts Sun 29 Mar 01:00 UTC; the whole later window
// is CEST (UTC+2). Before that instant it is CET (UTC+1). Matches build-empirical-profiles.mjs.
const DST_START = Date.UTC(2026, 2, 29, 1, 0, 0);
function toSwiss(d) {
  const off = d.getTime() >= DST_START ? 2 : 1;
  return new Date(d.getTime() + off * 3_600_000);
}

function direction(txt) {
  if (/Luzern\s*-?>\s*Gotthard/.test(txt)) return 'n';
  if (/Chiasso\s*-?>\s*Gotthard/.test(txt)) return 's';
  return null;
}

function congestionIndex(txt) {
  const km = txt.match(/(\d+)\s*km\s*Stau/);
  if (km) return +km[1];
  if (/Stau|Überlastung|stockend|Kolonne|zäh/.test(txt)) return 1.5;
  return null;
}

const tweets = JSON.parse(readFileSync(SRC, 'utf8'));

// days[iso][dir] = [[minuteOfDay, idx], ...] sorted by minute
const days = {};
let used = 0;
let firstIso = '9999';
let lastIso = '0000';

for (const t of tweets) {
  const txt = dec(t.text);
  const dir = direction(txt);
  if (!dir) continue;
  const idx = congestionIndex(txt);
  if (idx == null) continue;

  const s = toSwiss(new Date(t.created_at));
  const iso = s.toISOString().slice(0, 10);
  const minuteOfDay = s.getUTCHours() * 60 + s.getUTCMinutes();

  ((days[iso] ??= {})[dir] ??= []).push([minuteOfDay, idx]);
  used++;
  if (iso < firstIso) firstIso = iso;
  if (iso > lastIso) lastIso = iso;
}

for (const iso of Object.keys(days)) {
  for (const dir of ['n', 's']) {
    if (days[iso][dir]) days[iso][dir].sort((a, b) => a[0] - b[0]);
  }
}

const data = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'tcs_gotthard_tweets.json',
    usedReports: used,
    dateStart: firstIso,
    dateEnd: lastIso,
    note: 'Per Swiss-local day: sparse [minuteOfDay, km] congestion reports per direction (n = Nordportal/southbound, s = Südportal/northbound). Not a continuous curve — only sent while a jam is building/clearing.',
  },
  days,
};

writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');

const dayCount = Object.keys(days).length;
console.log(`Read ${tweets.length} tweets, used ${used} congestion reports across ${dayCount} days`);
console.log(`Window: ${firstIso} → ${lastIso}`);
console.log(`Wrote ${OUT}`);
