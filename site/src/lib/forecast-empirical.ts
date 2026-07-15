// Data-driven layer for the Gotthard forecast.
//
// Reads empirical-profiles.json — weekday×hour congestion profiles and measured
// public-holiday multipliers derived from ~7 weeks of real TCS traffic reports
// (see scripts/build-empirical-profiles.mjs) — and turns them into fully-scaled
// 0–10 congestion profiles for a given day.
//
// forecast.ts prefers these whenever a weekday has enough observed days; otherwise
// it falls back to the hand-tuned seasonal model (e.g. for months the data never
// covered). The empirical window is spring 2026 (Mar–May); magnitudes for other
// months are extrapolated via the seasonScale the caller supplies.

import raw from '../data/empirical-profiles.json';

// A weekday needs at least this many observed baseline days to be trusted.
const MIN_DAYS = 3;

export interface EmpiricalProfiles {
  n: number[]; // 24 hourly indices, Nordportal Göschenen (southbound, CH→IT)
  s: number[]; // 24 hourly indices, Südportal Airolo (northbound, IT→CH)
}

/** Day-weighted SEASON weight of the observed window — the base magnitudes are at this level. */
export const seasonBaseline: number = raw.meta.seasonBaseline;

/** Window covered by the underlying data, for UI disclosure. */
export const empiricalMeta = {
  dateStart: raw.meta.dateStart,
  dateEnd: raw.meta.dateEnd,
  usedReports: raw.meta.usedReports,
};

/** True when weekday `dow` (0=Sun) has enough observed days to trust its profile. */
export function hasEmpirical(dow: number): boolean {
  return (raw.sampleDays[dow] ?? 0) >= MIN_DAYS;
}

/**
 * Measured per-direction peak multiplier for a public-holiday travel period, or
 * null if that period wasn't observed in the data. Keys match `empiricalKey` on
 * the holiday periods in forecast.ts (e.g. 'easter', 'labourday').
 */
export function measuredHolidayMult(key: string | null | undefined): { n: number; s: number } | null {
  if (!key) return null;
  const h = (raw.holiday as Record<string, { multN: number; multS: number }>)[key];
  return h ? { n: h.multN, s: h.multS } : null;
}

/**
 * Fully-scaled empirical profiles for a weekday, or null when the weekday has too
 * few observed days. `seasonScale` extrapolates the spring baseline magnitude to
 * the target month; `holMultN`/`holMultS` apply the (measured or model-derived)
 * holiday boost per direction.
 */
export function empiricalDayProfiles(
  dow: number,
  seasonScale: number,
  holMultN: number,
  holMultS: number,
): EmpiricalProfiles | null {
  if (!hasEmpirical(dow)) return null;
  const baseN = raw.weekdayHour.N[dow];
  const baseS = raw.weekdayHour.S[dow];
  return {
    n: baseN.map((v) => +(v * seasonScale * holMultN).toFixed(3)),
    s: baseS.map((v) => +(v * seasonScale * holMultS).toFixed(3)),
  };
}
