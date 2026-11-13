// Per-day forecast summary for a date range (holiday landing pages).
//
// Build-time fallback for the <!--SSR:forecast-range:FROM:TO--> marker: the
// server replaces the table with a fresh one per request, but the static HTML
// must not be empty. Uses the same model as the forecast page (forecast.ts).

import { generateDayCurve } from './forecast';
import type { Lang } from './i18n';

export interface DirPeak {
  /** Typical-day peak wait (min). */
  typ: number;
  /** Busy-day peak wait (min), the upper edge of the forecast range. */
  high: number;
  /** Swiss local minute of day of the typical peak. */
  minute: number;
}

export interface DayPeak {
  isoDate: string;
  dayLabel: string;
  fullDayLabel: string;
  dateLabel: string;
  context: string | null;
  north: DirPeak;
  south: DirPeak;
  /** Swiss local hours [first, last] where the typical wait (either direction) reaches the threshold; null = quiet all day. */
  busy: [number, number] | null;
}

/** ISO dates from `from` to `to` inclusive ("2026-12-19" … "2027-01-04"). */
export function isoDates(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(to + 'T12:00:00Z');
  for (let t = Date.parse(from + 'T12:00:00Z'); t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Wait (min) from which an hour counts as "busy" for the quiet-window advice. */
export const BUSY_MIN = 10;

export function forecastRange(from: string, to: string, lang: Lang): DayPeak[] {
  return isoDates(from, to).map((iso) => {
    // 11:00 UTC is midday in Zurich (CET or CEST), safely inside the date.
    const curve = generateDayCurve(new Date(iso + 'T11:00:00Z'), lang);
    const north: DirPeak = { typ: 0, high: 0, minute: 0 };
    const south: DirPeak = { typ: 0, high: 0, minute: 0 };
    let first = -1;
    let last = -1;
    for (const p of curve.points) {
      if (p.northWait > north.typ) Object.assign(north, { typ: p.northWait, high: p.northWaitHigh, minute: p.minuteOfDay });
      if (p.southWait > south.typ) Object.assign(south, { typ: p.southWait, high: p.southWaitHigh, minute: p.minuteOfDay });
      if (p.minuteOfDay < 1440 && Math.max(p.northWait, p.southWait) >= BUSY_MIN) {
        const h = Math.floor(p.minuteOfDay / 60);
        if (first < 0) first = h;
        last = h;
      }
    }
    return {
      isoDate: curve.isoDate,
      dayLabel: curve.fullDayLabel.slice(0, lang === 'de' ? 2 : 3),
      fullDayLabel: curve.fullDayLabel,
      dateLabel: curve.dateLabel,
      context: curve.context,
      north,
      south,
      busy: first < 0 ? null : [first, last],
    };
  });
}

/** Day with the highest typical peak in one direction. */
export function worstDay(days: DayPeak[], dir: 'north' | 'south'): DayPeak {
  return days.reduce((a, b) => (b[dir].typ > a[dir].typ ? b : a));
}

/** Earliest start and latest end of the busy hours over all days (null = quiet throughout). */
export function busySpan(days: DayPeak[]): [number, number] | null {
  const spans = days.map((d) => d.busy).filter((b): b is [number, number] => b !== null);
  if (!spans.length) return null;
  return [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))];
}

/** Easter Sunday as "YYYY-MM-DD" (Anonymous Gregorian algorithm, same as forecast.ts). */
export function easterSundayIso(year: number): string {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO date shifted by whole days. */
export function shiftIso(iso: string, days: number): string {
  return new Date(Date.parse(iso + 'T12:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);
}

export const hhmm =(minute: number) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** "15–27" or "15" when the busy-day edge adds nothing. */
export const waitRange = (p: DirPeak) => (p.high > p.typ + 1 ? `${p.typ}–${p.high}` : `${p.typ}`);
