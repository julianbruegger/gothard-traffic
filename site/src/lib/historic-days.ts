// Real past-day congestion data, derived from TCS Gotthard traffic reports
// (tcs_gotthard_tweets.json → scripts/build-historic-days.mjs → historic-days.json).
//
// Reports are sparse (only sent while a jam is building or clearing), so a day's
// raw points can't be connected directly — `expand()` brackets each isolated
// report (or gap between reports) with a synthetic zero a few minutes out, then
// `sampleAt` linearly interpolates that shape onto the same 10-minute grid the
// forecast curve uses, so historic and predicted lines are directly comparable.

import raw from '../data/historic-days.json';
import { idxToWaitMinutes } from './forecast';

type RawPoint = [number, number]; // [minuteOfDay, congestion index]
interface RawDay {
  n?: RawPoint[];
  s?: RawPoint[];
}

export const historicMeta = {
  dateStart: raw.meta.dateStart,
  dateEnd: raw.meta.dateEnd,
};

const GAP_MIN = 60;    // reports further apart than this are treated as separate jam events
const SETTLE_MIN = 15; // minutes assumed to ramp to/from zero around an isolated report

function expand(points: RawPoint[]): RawPoint[] {
  const out: RawPoint[] = [];
  out.push([Math.max(0, points[0][0] - SETTLE_MIN), 0]);
  out.push(points[0]);
  for (let i = 1; i < points.length; i++) {
    const prevM = points[i - 1][0];
    const curM = points[i][0];
    if (curM - prevM > GAP_MIN) {
      out.push([Math.min(1440, prevM + SETTLE_MIN), 0]);
      out.push([Math.max(0, curM - SETTLE_MIN), 0]);
    }
    out.push(points[i]);
  }
  out.push([Math.min(1440, points[points.length - 1][0] + SETTLE_MIN), 0]);
  return out;
}

function sampleAt(expanded: RawPoint[], minute: number): number {
  if (minute <= expanded[0][0]) return expanded[0][1];
  for (let i = 1; i < expanded.length; i++) {
    if (minute <= expanded[i][0]) {
      const [m0, v0] = expanded[i - 1];
      const [m1, v1] = expanded[i];
      const frac = m1 === m0 ? 0 : (minute - m0) / (m1 - m0);
      return v0 + (v1 - v0) * frac;
    }
  }
  return expanded[expanded.length - 1][1];
}

export interface HistoricDaySeries {
  isoDate: string;
  waitMinutes: number[]; // resampled onto the caller-supplied grid
}

/** ISO dates in the TCS dataset that fall on weekday `dow` (0=Sun..6=Sat), most recent first. */
export function historicDatesForWeekday(dow: number): string[] {
  return Object.keys(raw.days as unknown as Record<string, RawDay>)
    .filter((iso) => new Date(`${iso}T12:00:00Z`).getUTCDay() === dow)
    .sort()
    .reverse();
}

/**
 * One historic day's reports for one direction, resampled onto `gridMinutes`
 * (the forecast curve's minute-of-day samples) and converted to wait minutes.
 * Returns null if that day has no reports for the requested direction.
 */
export function historicDaySeries(
  isoDate: string,
  dir: 'n' | 's',
  gridMinutes: number[],
): HistoricDaySeries | null {
  const points = (raw.days as unknown as Record<string, RawDay>)[isoDate]?.[dir];
  if (!points || points.length === 0) return null;
  const expanded = expand(points);
  return {
    isoDate,
    waitMinutes: gridMinutes.map((m) => idxToWaitMinutes(sampleAt(expanded, m))),
  };
}
