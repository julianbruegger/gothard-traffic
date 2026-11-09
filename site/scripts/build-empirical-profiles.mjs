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

// Longest plausible A2 approach queue. The Gotthard north approach only runs
// ~40 km from Beckenried to Göschenen, so anything beyond ~30 km is a TCS typo
// (e.g. "90 km Stau") and gets clamped rather than skewing the peaks.
const MAX_KM = 30;

// Congestion index from a report. Non-congestion incident-only tweets return null
// (an Unfall or closure is not a recurring weekday pattern we can predict).
function congestionIndex(txt) {
  // Allow a decimal (e.g. "2.3 km"); the old `\d+` matched the fractional digits
  // of "2.33333 km" and produced absurd values.
  const km = txt.match(/(\d+(?:[.,]\d+)?)\s*km\s*Stau/);
  if (km) return Math.min(MAX_KM, +km[1].replace(',', '.'));
  if (/Stau|Überlastung|stockend|Kolonne|zäh/.test(txt)) return 1.5;
  return null;
}

const isoDayOf = (swiss) => swiss.toISOString().slice(0, 10);

// ─── Holiday travel windows, generated for every year in the data range ─────────
// The tweet history spans ~2016–2026, so the holiday effect (and the exclusion of
// holiday days from the weekday baseline) has to be computed per year rather than
// hard-coded to a single spring. Easter drives the biggest movable jam; the exodus
// starts a few days before Good Friday and the return runs the week after, so we
// treat E-4 … E+8 as the Easter travel period. Labour Day (1 May) makes a 1–3 May
// long weekend in several cantons.

// Easter Sunday for a year (Anonymous Gregorian algorithm).
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

const isoUTC = (d) => d.toISOString().slice(0, 10);
const shiftDays = (d, n) => new Date(d.getTime() + n * 86_400_000);

function buildHolidayWindows(fromYear, toYear) {
  const windows = [];
  for (let y = fromYear; y <= toYear; y++) {
    const easter = easterSunday(y);
    windows.push({
      name: 'easter',
      label: 'Osterferien / Easter',
      from: isoUTC(shiftDays(easter, -4)),
      to: isoUTC(shiftDays(easter, 8)),
    });
    windows.push({
      name: 'labourday',
      label: '1. Mai / Labour Day',
      from: `${y}-05-01`,
      to: `${y}-05-03`,
    });
  }
  return windows;
}

// Populated once the observed year range is known (see below).
let HOLIDAY_WINDOWS = [];
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

// Now that the observed range is known, generate holiday windows for every year.
HOLIDAY_WINDOWS = buildHolidayWindows(+firstIso.slice(0, 4), +lastIso.slice(0, 4));

// ─── Weekday × hour baseline profiles (non-holiday days only) ──────────────────

const DOW_LABEL = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const dowOf = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

// Season baseline: mean SEASON weight of the observed baseline days themselves,
// NOT of every calendar day in the range. The tweet history is summer-heavy, so
// the profile magnitudes correspond to a higher season level than the calendar
// average — using the wrong denominator would inflate every extrapolated month.
// Must run after HOLIDAY_WINDOWS is populated so holiday days are excluded.
function seasonBaselineWeight() {
  const baselineDays = [...new Set([...Object.keys(bucket.N), ...Object.keys(bucket.S)])]
    .filter((iso) => !holidayOf(iso));
  if (baselineDays.length === 0) return SEASON[3];
  const sum = baselineDays.reduce((acc, iso) => acc + SEASON[+iso.slice(5, 7) - 1], 0);
  return sum / baselineDays.length;
}
const seasonBaseline = +seasonBaselineWeight().toFixed(3);

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
  // Circular 3-point [1,2,1] smoothing, applied twice (≈ a 5-point Gaussian).
  // A single pass leaves the sparse weekday profiles jagged — e.g. a Thursday
  // queue that builds, dips mid-morning, then rebuilds, which is a sampling
  // artifact (few weekday jam-days), not a real pattern. Two passes remove those
  // mid-build dips while the broad, well-sampled weekend peaks survive (they span
  // several hours); the later peak-normalization restores any slight blunting.
  const pass = (row) =>
    row.map((_, h) => +(((row[(h + 23) % 24] + 2 * row[h] + row[(h + 1) % 24]) / 4)).toFixed(4));
  const smoothed = profile.map((row) => pass(pass(row)).map((v) => +v.toFixed(2)));
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

// ─── Rescale hourly shape to the realistic daily peak ──────────────────────────
// The hourly means above answer "what queue is on the road at hour H, averaged
// over EVERY day of this weekday". Over 10 years that mean is heavily diluted:
// jams peak at different hours on different days and many days are quiet, so no
// single hour retains the true peak (a summer Saturday's hourly-mean peak is only
// ~1.6 km even though the mean *daily* peak is ~5.8 km). Using it directly makes
// the forecast predict near-empty roads on peak days.
//
// Fix: keep the time-of-day SHAPE from the hourly means (it captures *when* jams
// build and fade) but rescale each weekday's curve so its own peak equals that
// weekday's mean daily peak (baseN/baseS) — the honest "typical worst queue".
function normalizeToPeak(profile, targetPeaks) {
  return profile.map((row, dow) => {
    const cur = Math.max(...row);
    const tgt = targetPeaks[dow];
    if (cur <= 0 || tgt <= 0) return row.map(() => 0);
    const k = tgt / cur;
    return row.map((v) => +(v * k).toFixed(2));
  });
}
const profN = normalizeToPeak(wN.profile, baseN);
const profS = normalizeToPeak(wS.profile, baseS);

// ─── Busy-day range: how much worse a bad day is than the typical one ──────────
// The normalized profiles above track the *mean* daily peak. But Gotthard queues
// are strongly right-skewed — most days are moderate, a handful are catastrophic —
// so on any given bad day the real queue runs well above that mean. To show an
// honest "typical → busy day" range instead of a single line that any incident
// blows past, we measure, per weekday and direction, the 90th-percentile daily
// peak and express it as a multiplier over the mean. The forecast's upper band is
// then `typical × ratio`. Clamped to [1, 3] and floored so a busy day is always
// at least somewhat worse than typical even where samples are thin.
function busyRatioByDow(dir) {
  const perDow = Array.from({ length: 7 }, () => []);
  const allDays = new Set([...Object.keys(bucket.N), ...Object.keys(bucket.S)]);
  for (const iso of allDays) {
    if (holidayOf(iso)) continue;
    perDow[dowOf(iso)].push(dailyPeak(dir, iso));
  }
  return perDow.map((vals) => {
    if (vals.length < 5) return 1.6; // too few days to trust a percentile
    const sorted = [...vals].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
    if (mean <= 0) return 1.6;
    return +Math.max(1.15, Math.min(3, p90 / mean)).toFixed(2);
  });
}
const highRatioN = busyRatioByDow('N');
const highRatioS = busyRatioByDow('S');

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
  weekdayHour: { N: profN, S: profS },
  weekdayHighRatio: { N: highRatioN, S: highRatioS }, // busy-day (p90) multiplier over the typical peak, per weekday
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
    `  ${DOW_LABEL[d]}    ${baseN[d].toFixed(1).padStart(6)} (×${highRatioN[d]} busy)   ${baseS[d].toFixed(1).padStart(6)} (×${highRatioS[d]} busy)`,
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
