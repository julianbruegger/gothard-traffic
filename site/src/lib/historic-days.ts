// Past-day comparison lines for the day chart, drawn from our own ASTRA
// measurements (observed-live.ts: runtime data from api/observed.php, with the
// bundled observed-days.json as fallback).
//
// Only the most recent same-weekday days count: a comparison line from months
// ago (Easter traffic next to a November forecast) says nothing about the day
// shown. If no measured same-weekday day is recent enough, there is no overlay.

import { ASTRA_MIN_PER_KM, idxToWaitMinutes, swissDayInfo } from './forecast';
import { currentObservedDays } from './observed-live';
import type { ObservedDay } from './observed-model';

/** Comparison days older than this (relative to today) are not shown. */
const MAX_AGE_DAYS = 35;

/** Range of the measured data, for the "no comparable day" note. */
export const historicMeta = {
  get dateStart(): string {
    return currentObservedDays()[0]?.d ?? '–';
  },
  get dateEnd(): string {
    return currentObservedDays().at(-1)?.d ?? '–';
  },
};

const dayMs = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

export interface HistoricDaySeries {
  isoDate: string;
  waitMinutes: number[]; // resampled onto the caller-supplied grid
}

/** ISO dates of recent measured days on weekday `dow` (0=Sun..6=Sat), most recent first. */
export function historicDatesForWeekday(dow: number): string[] {
  const today = swissDayInfo(new Date()).isoDate;
  const oldest = dayMs(today) - MAX_AGE_DAYS * 86_400_000;
  return currentObservedDays()
    .filter((d) => d.d < today && dayMs(d.d) >= oldest && new Date(dayMs(d.d)).getUTCDay() === dow)
    .map((d) => d.d)
    .sort()
    .reverse();
}

/** Linear interpolation of an hourly series (value at hh:00) at `minute`; gaps are bridged. */
function sampleHourly(hours: (number | null)[], minute: number): number | null {
  const pos = Math.min(23, Math.max(0, minute / 60));
  let lo = Math.floor(pos);
  let hi = Math.ceil(pos);
  while (lo >= 0 && hours[lo] === null) lo--;
  while (hi <= 23 && hours[hi] === null) hi++;
  if (lo < 0 && hi > 23) return null;
  if (lo < 0) return hours[hi];
  if (hi > 23) return hours[lo];
  if (lo === hi) return hours[lo];
  const frac = (pos - lo) / (hi - lo);
  return (hours[lo] as number) + ((hours[hi] as number) - (hours[lo] as number)) * frac;
}

/**
 * One measured day for one direction, resampled onto `gridMinutes` (the forecast
 * curve's minute-of-day samples) and converted to wait minutes. Returns null if
 * that day has no readings for the direction.
 */
export function historicDaySeries(
  isoDate: string,
  dir: 'n' | 's',
  gridMinutes: number[],
): HistoricDaySeries | null {
  const day: ObservedDay | undefined = currentObservedDays().find((d) => d.d === isoDate);
  if (!day || day[dir].every((v) => v === null)) return null;
  return {
    isoDate,
    waitMinutes: gridMinutes.map((m) => idxToWaitMinutes(sampleHourly(day[dir], m) ?? 0, ASTRA_MIN_PER_KM)),
  };
}
