#!/usr/bin/env node
// Derives empirical congestion profiles for the Gotthard tunnel from the
// TCS Gotthard traffic-report history (tcs_gotthard_tweets.json) and correlates
// the observed jams with the public-holiday calendar.
//
// Output: site/src/data/empirical-profiles.json — consumed by
// site/src/lib/forecast-empirical.ts to make the forecast data-driven.
//
// Usage: node site/scripts/build-empirical-profiles.mjs
//
// Direction mapping (from the tweet prefix "#A2 - X -> Y -"):
//   "Luzern  -> Gotthard"  = queue at Nordportal Göschenen  (southbound, CH/DE → IT)  => N  (northIdx)
//   "Chiasso -> Gotthard"  = queue at Südportal Airolo      (northbound, IT → CH/DE)  => S  (southIdx)
//
// Index units match forecast.ts: 0 = free flow, 10 ≈ 10 km / 90 min jam. TCS reports
// ~10 min delay per km, so we use km directly as the congestion index (capped display).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(REPO_ROOT, 'tcs_gotthard_tweets.json');
const OUT = resolve(__dirname, '..', 'src', 'data', 'empirical-profiles.json');

// SEASON weights from forecast.ts (Jan..Dec). Used to express the empirical
// spring magnitudes on the same scale the model extrapolates to other months.
const SEASON = [0.25, 0.25, 0.45, 0.65, 0.6, 0.75, 1.0, 1.0, 0.75, 0.6, 0.35, 0.25];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const dec = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

// Swiss local time. DST 2026 starts Sun 29 Mar 01:00 UTC; the whole later window
// is CEST (UTC+2). Before that instant it is CET (UTC+1).
const DST_START = Date.UTC(2026, 2, 29, 1, 0, 0);
function toSwiss(d) {
  const off = d.getTime() >= DST_START ? 2 : 1;
  return new Date(d.getTime() + off * 3_600_000);
}

function direction(txt) {
  if (/Luzern\s*-?>\s*Gotthard/.test(txt)) return 'N';
  if (/Chiasso\s*-?>\s*Gotthard/.test(txt)) return 'S';
  return null; // exits / incidents in the far direction — ignored for the profile
}

// Congestion index from a report. Non-congestion incident-only tweets return null
// (an Unfall or closure is not a recurring weekday pattern we can predict).
function congestionIndex(txt) {
  const km = txt.match(/(\d+)\s*km\s*Stau/);
  if (km) return +km[1];
  if (/Stau|Überlastung|stockend|Kolonne|zäh/.test(txt)) return 1.5;
  return null;
}

const isoDayOf = (swiss) => swiss.toISOString().slice(0, 10);

// ─── Holiday windows inside the data range (Mar 26 – May 13 2026) ──────────────
// Easter 2026: Good Friday 3 Apr, Easter Sun 5 Apr, Easter Mon 6 Apr.
// The observed exodus starts the Wed before and the return runs the week after,
// so we treat 1–13 Apr as the Easter travel period.
// Labour Day 1 May (Fri) creates a 1–3 May long weekend in several cantons.
const HOLIDAY_WINDOWS = [
  { name: 'easter', label: 'Osterferien / Easter', from: '2026-04-01', to: '2026-04-13' },
  { name: 'labourday', label: '1. Mai / Labour Day', from: '2026-05-01', to: '2026-05-03' },
];
function holidayOf(iso) {
  return HOLIDAY_WINDOWS.find((h) => iso >= h.from && iso <= h.to)?.name ?? null;
}

// ─── Load & bucket ─────────────────────────────────────────────────────────────

const tweets = JSON.parse(readFileSync(SRC, 'utf8'));

// bucket[dir][iso][hour] = max index observed in that Swiss-local hour
const bucket = { N: {}, S: {} };
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
  const iso = isoDayOf(s);
  const h = s.getUTCHours();
  (bucket[dir][iso] ??= {})[h] = Math.max(bucket[dir][iso][h] ?? 0, idx);
  used++;
  if (iso < firstIso) firstIso = iso;
  if (iso > lastIso) lastIso = iso;
}

// Season baseline: day-weighted SEASON weight across the observed window.
function seasonBaselineWeight() {
  let sum = 0;
  let n = 0;
  const start = new Date(firstIso + 'T12:00:00Z');
  const end = new Date(lastIso + 'T12:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    sum += SEASON[d.getUTCMonth()];
    n++;
  }
  return sum / n;
}
const seasonBaseline = +seasonBaselineWeight().toFixed(3);

// ─── Weekday × hour baseline profiles (non-holiday days only) ──────────────────

const DOW_LABEL = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const dowOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

function buildWeekdayHour(dir) {
  // sums[dow][hour] and per-weekday day counts, over baseline (non-holiday) days
  const sums = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const dayCount = new Array(7).fill(0);
  const seenDays = Array.from({ length: 7 }, () => new Set());

  const allDays = new Set([...Object.keys(bucket.N), ...Object.keys(bucket.S)]);
  for (const iso of allDays) {
    if (holidayOf(iso)) continue; // baseline excludes holiday travel periods
    const dow = dowOf(iso);
    if (!seenDays[dow].has(iso)) {
      seenDays[dow].add(iso);
      dayCount[dow]++;
    }
    const hours = bucket[dir][iso] ?? {};
    for (let h = 0; h < 24; h++) sums[dow][h] += hours[h] ?? 0;
  }

  const profile = sums.map((row, dow) =>
    row.map((v) => (dayCount[dow] ? v / dayCount[dow] : 0)),
  );
  // Light circular 3-point smoothing to tame single-sample spikes.
  const smoothed = profile.map((row) =>
    row.map((_, h) => {
      const a = row[(h + 23) % 24];
      const b = row[h];
      const c = row[(h + 1) % 24];
      return +(((a + 2 * b + c) / 4)).toFixed(2);
    }),
  );
  return { profile: smoothed, dayCount };
}

const wN = buildWeekdayHour('N');
const wS = buildWeekdayHour('S');

// ─── Holiday effect: peak-index multiplier vs same-weekday baseline ────────────

function dailyPeak(dir, iso) {
  const hours = bucket[dir][iso] ?? {};
  const vals = Object.values(hours);
  return vals.length ? Math.max(...vals) : 0;
}

function baselinePeakByDow(dir) {
  const sums = new Array(7).fill(0);
  const cnt = new Array(7).fill(0);
  const allDays = new Set([...Object.keys(bucket.N), ...Object.keys(bucket.S)]);
  for (const iso of allDays) {
    if (holidayOf(iso)) continue;
    const dow = dowOf(iso);
    sums[dow] += dailyPeak(dir, iso);
    cnt[dow]++;
  }
  return sums.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
}
const baseN = baselinePeakByDow('N');
const baseS = baselinePeakByDow('S');
const meanBase = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

function holidayEffect() {
  const out = {};
  const allDays = new Set([...Object.keys(bucket.N), ...Object.keys(bucket.S)]);
  for (const hw of HOLIDAY_WINDOWS) {
    let peakN = 0;
    let peakS = 0;
    let sumN = 0;
    let sumS = 0;
    let days = 0;
    const perDay = [];
    for (const iso of [...allDays].sort()) {
      if (holidayOf(iso) !== hw.name) continue;
      const pn = dailyPeak('N', iso);
      const ps = dailyPeak('S', iso);
      peakN = Math.max(peakN, pn);
      peakS = Math.max(peakS, ps);
      sumN += pn;
      sumS += ps;
      days++;
      perDay.push({ iso, dow: DOW_LABEL[dowOf(iso)], n: pn, s: ps });
    }
    // Multiplier = holiday mean peak / overall baseline mean peak, floored at 1.
    const baseMeanN = meanBase(baseN) || 1;
    const baseMeanS = meanBase(baseS) || 1;
    out[hw.name] = {
      label: hw.label,
      days,
      peakN,
      peakS,
      multN: +Math.max(1, sumN / days / baseMeanN).toFixed(2),
      multS: +Math.max(1, sumS / days / baseMeanS).toFixed(2),
      perDay,
    };
  }
  return out;
}
const holiday = holidayEffect();

// ─── Emit ──────────────────────────────────────────────────────────────────────

const data = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: 'tcs_gotthard_tweets.json',
    tweetCount: tweets.length,
    usedReports: used,
    dateStart: firstIso,
    dateEnd: lastIso,
    seasonBaseline,
    note: 'Index units: 0 = free flow, ~10 = 10 km / 90 min. N = Nordportal Göschenen (southbound), S = Südportal Airolo (northbound).',
  },
  weekdayHour: { N: wN.profile, S: wS.profile },
  sampleDays: wN.dayCount, // baseline day count per weekday (Sun=0)
  holiday,
};

writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n');

// ─── Human-readable summary ────────────────────────────────────────────────────

console.log(`Read ${tweets.length} tweets, used ${used} congestion reports`);
console.log(`Window: ${firstIso} → ${lastIso}  (season baseline weight ${seasonBaseline})`);
console.log(`Baseline days per weekday (Sun..Sat): ${wN.dayCount.join(' ')}`);
console.log('\nTypical peak km by weekday (non-holiday baseline):');
console.log('  DOW   N(south exodus)  S(north return)');
for (let d = 0; d < 7; d++) {
  console.log(
    `  ${DOW_LABEL[d]}    ${baseN[d].toFixed(1).padStart(6)}          ${baseS[d].toFixed(1).padStart(6)}`,
  );
}
console.log('\nHoliday correlation:');
for (const k of Object.keys(holiday)) {
  const h = holiday[k];
  console.log(
    `  ${h.label}: ${h.days} days, peak N=${h.peakN}km S=${h.peakS}km  → mult N×${h.multN} S×${h.multS}`,
  );
  for (const p of h.perDay) {
    console.log(`      ${p.iso} ${p.dow}  N=${String(p.n).padStart(2)}km  S=${String(p.s).padStart(2)}km`);
  }
}
console.log(`\nWrote ${OUT}`);
