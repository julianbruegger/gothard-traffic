// Forecast layer learned from the site's own measurements.
//
// observed-days.json holds the mean ASTRA queue length (km) per Swiss-local hour
// for every day the collector has recorded (scripts/build-observed-days.mjs
// condenses the gotthard_snapshots DB export into it). Unlike the TCS tweet
// history, which only exists when someone reported a jam, this is a continuous
// reading every ~3 minutes, quiet days included, and it is the same source the
// live page shows, so forecast and live values share one scale.
//
// Model, per direction d (n = Nordportal, s = Südportal):
//
//   km(date, hour) = shape[d][dow][hour] × level[d](date) × monthCorr[d][month]
//
//   level      the calendar prior from forecast.ts: SEASON × holiday effect for
//              that date. It carries the seasonality into months the
//              measurements do not cover yet.
//   monthCorr  how far the measured months deviate from that prior, shrunk
//              towards 1 by the number of observed days (a month with 3 days of
//              data barely moves; a fully observed month is mostly measured).
//              Normalised so the observed days average 1, which anchors the
//              absolute scale of every month to the measurements.
//   shape      mean hourly queue per weekday at level 1. It is an expected
//              value, not a peak-normalised curve, so it is the best single
//              guess for each hour.
//   high       90th percentile per weekday and hour, the "busy day" band.
//   recent     the effective correction of the last RECENT_DAYS measured days.
//              Traffic shifts faster than calendar months (e.g. the autumn drop
//              after the October holidays), so for dates just after the data
//              ends the month correction is blended towards this recent level,
//              fading out with distance (a stale export falls back gracefully).

import observed from '../data/observed-days.json';

export interface ObservedDay {
  d: string;               // Swiss-local date "2026-08-14"
  n: (number | null)[];    // 24 hourly mean km, Nordportal Göschenen (southbound)
  s: (number | null)[];    // 24 hourly mean km, Südportal Airolo (northbound)
}

export type Dir = 'n' | 's';
export type LevelFn = (isoDate: string) => { n: number; s: number };

export interface ObservedModel {
  shape: Record<Dir, number[][]>;      // [dow][hour] km at level 1
  high: Record<Dir, number[][]>;       // [dow][hour] busy-day km at level 1
  monthCorr: Record<Dir, number[]>;    // [month 0–11] posterior correction
  recentCorr: Record<Dir, number>;     // effective correction over the last RECENT_DAYS days
  recentGroup: Record<Dir, number[]>;  // same, per weekday group (see weekdayGroup)
  persist: Record<Dir, number[][][]>;  // [dow][k][hour] normalised hourly km of the last same-weekday days, newest first
  persistWeight: number;
  persistTau: number;
  recentWeight: number;
  recentTau: number;
  monthDays: number[];                 // observed days per month
  dowDays: number[];                   // observed days per weekday
  dateStart: string;
  dateEnd: string;
  days: number;
}

/** Observed days needed per weekday before its profile is trusted. */
export const MIN_DOW_DAYS = 3;
/** Pseudo-days pulling a month's correction towards 1 (the calendar prior). */
const SHRINK_DAYS = 7;
/** Upper quantile used for the busy-day band. */
const HIGH_QUANTILE = 0.9;
/** Window for the recent-level estimate. */
const RECENT_DAYS = 14;
/** Window and shrinkage (pseudo-days) for the per-weekday-group recent level. */
const RECENT_GROUP_DAYS = 28;
const GROUP_SHRINK = 3;

export interface FitOptions {
  /** Weight of the recent level on the day right after the data ends (0 = off). */
  recentWeight?: number;
  /** e-folding time (days) over which the recent level fades out. */
  recentTau?: number;
  /**
   * 0 = typical curve is the plain hourly mean; 1 = curve scaled so its peak
   * equals the weekday's mean daily peak (jams happen at slightly different
   * times each week, so the hourly mean flattens every peak).
   */
  peakScale?: number;
  /** Weight of the same-weekday persistence curve on the day right after the data ends (0 = off). */
  persistWeight?: number;
  /** e-folding time (days) over which the persistence weight fades out. */
  persistTau?: number;
}
const DEFAULT_FIT: Required<FitOptions> = {
  recentWeight: 0.8, recentTau: 14, peakScale: 0.75, persistWeight: 0.8, persistTau: 20,
};
/** Number of recent same-weekday days kept for the persistence term, and their decay per week back. */
const PERSIST_DAYS = 4;
const PERSIST_DECAY = 0.6;

export const observedDays: ObservedDay[] = (observed as { days: ObservedDay[] }).days;
export const observedMeta = (observed as { meta: { firstReading: string; lastReading: string; readings: number } }).meta;

/** Weekday groups with their own recent level: Mon–Thu, Fri, Sat, Sun. */
export const weekdayGroup = (dow: number) => (dow === 0 ? 3 : dow === 6 ? 2 : dow === 5 ? 1 : 0);

const dowOf = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const monthOf = (iso: string) => +iso.slice(5, 7) - 1;

/** Daily queue volume (km·h), scaling partially covered days up to 24 h. */
function dayVolume(hours: (number | null)[]): number {
  let sum = 0;
  let cnt = 0;
  for (const v of hours) {
    if (v !== null) { sum += v; cnt++; }
  }
  return cnt ? (sum / cnt) * 24 : 0;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// One circular [1,2,1] pass: removes 3-minute sampling jitter without moving peaks.
const smooth = (row: number[]) =>
  row.map((_, h) => (row[(h + 23) % 24] + 2 * row[h] + row[(h + 1) % 24]) / 4);

/** Replace missing hours by the nearest known value (a day needs most hours to get here). */
function fillGaps(hours: (number | null)[]): number[] {
  return hours.map((v, h) => {
    if (v !== null) return v;
    for (let d = 1; d < 24; d++) {
      const a = hours[h - d], b = hours[h + d];
      if (a != null) return a;
      if (b != null) return b;
    }
    return 0;
  });
}

const round = (v: number, d = 3) => +v.toFixed(d);

/**
 * Fit the model on a set of observed days. `levelOf` returns the calendar
 * prior (season × holiday) for a date, per direction. Returns null when there
 * is too little data to learn anything.
 */
export function fitObservedModel(
  days: ObservedDay[],
  levelOf: LevelFn,
  options: FitOptions = {},
): ObservedModel | null {
  const opts = { ...DEFAULT_FIT, ...options };
  if (days.length < 14) return null;

  const meta = days.map((day) => ({
    day,
    dow: dowOf(day.d),
    m: monthOf(day.d),
    level: levelOf(day.d),
  }));

  const monthDays = new Array(12).fill(0);
  const dowDays = new Array(7).fill(0);
  for (const x of meta) { monthDays[x.m]++; dowDays[x.dow]++; }

  const fitDir = (dir: Dir) => {
    const vol = meta.map((x) => dayVolume(x.day[dir]));
    const lvl = meta.map((x) => Math.max(1e-6, x.level[dir]));

    // Alternate between weekday volume and month correction (separates
    // "Sundays are busy" from "August is busy").
    const corr = new Array(12).fill(1);
    const dowVol = new Array(7).fill(0);
    for (let iter = 0; iter < 10; iter++) {
      const dSum = new Array(7).fill(0), dCnt = new Array(7).fill(0);
      meta.forEach((x, i) => { dSum[x.dow] += vol[i] / (lvl[i] * corr[x.m]); dCnt[x.dow]++; });
      for (let w = 0; w < 7; w++) dowVol[w] = dCnt[w] ? dSum[w] / dCnt[w] : 0;

      const mSum = new Array(12).fill(0), mCnt = new Array(12).fill(0);
      meta.forEach((x, i) => {
        if (dowVol[x.dow] > 0) { mSum[x.m] += vol[i] / (lvl[i] * dowVol[x.dow]); mCnt[x.m]++; }
      });
      for (let m = 0; m < 12; m++) corr[m] = mCnt[m] ? mSum[m] / mCnt[m] : 1;

      // Anchor: observed days average a correction of 1, so the overall scale
      // lives in the weekday volumes and unobserved months inherit it.
      const mean = meta.reduce((a, x) => a + corr[x.m], 0) / meta.length;
      if (mean > 0) for (let m = 0; m < 12; m++) if (mCnt[m]) corr[m] /= mean;
    }

    const post = corr.map((c, m) => (monthDays[m] * c + SHRINK_DAYS) / (monthDays[m] + SHRINK_DAYS));

    // Normalised hourly samples per weekday → mean shape and busy-day quantile.
    const samples: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
    meta.forEach((x, i) => {
      const k = lvl[i] * post[x.m];
      x.day[dir].forEach((v, h) => { if (v !== null) samples[x.dow][h].push(v / k); });
    });
    const meanShape = samples.map((row) =>
      smooth(row.map((vals) => (vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0))),
    );
    // Mean normalised daily peak per weekday, for the optional peak scaling.
    const peakSum = new Array(7).fill(0), peakCnt = new Array(7).fill(0);
    meta.forEach((x, i) => {
      const k = lvl[i] * post[x.m];
      const pk = Math.max(0, ...x.day[dir].map((v) => (v ?? 0) / k));
      peakSum[x.dow] += pk; peakCnt[x.dow]++;
    });
    const shape = meanShape.map((row, w) => {
      const cur = Math.max(...row);
      const target = peakCnt[w] ? peakSum[w] / peakCnt[w] : cur;
      const f = cur > 0 ? 1 + opts.peakScale * (target / cur - 1) : 1;
      return row.map((v) => round(v * f));
    });
    const high = samples.map((row, w) =>
      smooth(row.map((vals) => quantile([...vals].sort((a, b) => a - b), HIGH_QUANTILE)))
        .map((v, h) => round(Math.max(v, shape[w][h] * 1.15))),
    );
    // Recent effective correction: measured volume over the last RECENT_DAYS
    // days relative to what shape × calendar level alone would predict.
    const lastIso = meta.reduce((a, x) => (x.day.d > a ? x.day.d : a), '');
    const cutoff = new Date(Date.parse(lastIso + 'T12:00:00Z') - (RECENT_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    let obsSum = 0, predSum = 0;
    meta.forEach((x, i) => {
      if (x.day.d < cutoff) return;
      obsSum += vol[i];
      predSum += shape[x.dow].reduce((a, b) => a + b, 0) * lvl[i];
    });
    const recent = predSum > 0 ? obsSum / predSum : 1;

    // Same, per weekday group over a longer window (a quiet midweek must not
    // pull down the Saturday forecast), shrunk towards the overall recent level.
    const groupCutoff = new Date(Date.parse(lastIso + 'T12:00:00Z') - (RECENT_GROUP_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
    const gObs = [0, 0, 0, 0], gPred = [0, 0, 0, 0], gN = [0, 0, 0, 0];
    meta.forEach((x, i) => {
      if (x.day.d < groupCutoff) return;
      const g = weekdayGroup(x.dow);
      gObs[g] += vol[i];
      gPred[g] += shape[x.dow].reduce((a, b) => a + b, 0) * lvl[i];
      gN[g]++;
    });
    const recentGroup = gObs.map((o, g) => {
      const raw = gPred[g] > 0 ? o / gPred[g] : recent;
      return round((gN[g] * raw + GROUP_SHRINK * recent) / (gN[g] + GROUP_SHRINK));
    });

    // Last same-weekday days, normalised by their own calendar level and month
    // correction so a holiday week does not leak into a normal one.
    const persist: number[][][] = Array.from({ length: 7 }, () => []);
    meta
      .map((x, i) => ({ x, k: lvl[i] * post[x.m] }))
      .sort((a, b) => (a.x.day.d < b.x.day.d ? 1 : -1))
      .forEach(({ x, k }) => {
        if (persist[x.dow].length >= PERSIST_DAYS) return;
        if (x.day[dir].filter((v) => v !== null).length < 18) return;
        persist[x.dow].push(fillGaps(x.day[dir]).map((v) => round(v / k)));
      });

    return { shape, high, corr: post.map((v) => round(v)), recent: round(recent), recentGroup, persist };
  };

  const n = fitDir('n');
  const s = fitDir('s');
  const sorted = days.map((d) => d.d).sort();
  return {
    shape: { n: n.shape, s: s.shape },
    high: { n: n.high, s: s.high },
    monthCorr: { n: n.corr, s: s.corr },
    recentCorr: { n: n.recent, s: s.recent },
    recentGroup: { n: n.recentGroup, s: s.recentGroup },
    persist: { n: n.persist, s: s.persist },
    persistWeight: opts.persistWeight,
    persistTau: opts.persistTau,
    recentWeight: opts.recentWeight,
    recentTau: opts.recentTau,
    monthDays,
    dowDays,
    dateStart: sorted[0],
    dateEnd: sorted[sorted.length - 1],
    days: days.length,
  };
}

/** Typical and busy-day hourly profiles (km) for one date, or null if the weekday is unobserved. */
export function observedDayProfiles(
  model: ObservedModel,
  isoDate: string,
  level: { n: number; s: number },
): { n: number[]; s: number[]; nHigh: number[]; sHigh: number[] } | null {
  const dow = dowOf(isoDate);
  if (model.dowDays[dow] < MIN_DOW_DAYS) return null;
  const m = monthOf(isoDate);
  // Blend towards the recent level for dates shortly after the data ends.
  const gap = (Date.parse(isoDate + 'T12:00:00Z') - Date.parse(model.dateEnd + 'T12:00:00Z')) / 86_400_000;
  const w = gap > 0 ? model.recentWeight * Math.exp(-(gap - 1) / model.recentTau) : 0;
  const g = weekdayGroup(dow);
  const kN = level.n * ((1 - w) * model.monthCorr.n[m] + w * model.recentGroup.n[g]);
  const kS = level.s * ((1 - w) * model.monthCorr.s[m] + w * model.recentGroup.s[g]);
  // Same-weekday persistence: blend the typical curve with the exponentially
  // weighted mean of the last same-weekday days (already at level 1).
  const pw = gap > 0 ? model.persistWeight * Math.exp(-(gap - 1) / model.persistTau) : 0;
  const blend = (dir: Dir, k: number) => {
    const shape = model.shape[dir][dow];
    const days = model.persist[dir][dow];
    if (pw <= 0 || !days.length) return shape.map((v) => round(v * k));
    let wsum = 0;
    const avg = new Array(24).fill(0);
    days.forEach((d, i) => {
      const wi = Math.pow(PERSIST_DECAY, i);
      wsum += wi;
      for (let h = 0; h < 24; h++) avg[h] += wi * d[h];
    });
    return shape.map((v, h) => round(((1 - pw) * v + pw * (avg[h] / wsum)) * k));
  };
  const nTyp = blend('n', kN);
  const sTyp = blend('s', kS);
  const band = (dir: Dir, k: number, typ: number[]) =>
    model.high[dir][dow].map((v, h) => round(Math.max(v * k, typ[h] * 1.15)));
  return { n: nTyp, s: sTyp, nHigh: band('n', kN, nTyp), sHigh: band('s', kS, sTyp) };
}
