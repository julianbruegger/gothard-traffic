// Forecast model for Gotthard Tunnel traffic.
// Predicts typical congestion based on weekday, season, and CH/DE/AT/IT holiday calendar.
//
// northIdx = expected queue at Nordportal Göschenen  (southbound, CH/DE → Italy)
// southIdx = expected queue at Südportal Airolo      (northbound, Italy → CH/DE)
// Index 0 = no queue, 10 = extreme jam (>10 km / 90+ min)

import {
  empiricalDayProfiles,
  measuredHolidayMult,
  seasonBaseline,
} from './forecast-empirical';

export type TrafficLevel = 'low' | 'moderate' | 'high' | 'extreme';

export interface ForecastHour {
  localHour: number;
  northIdx: number;
  southIdx: number;
  northLevel: TrafficLevel;
  southLevel: TrafficLevel;
}

export interface ForecastDay {
  isoDate: string;       // "2026-07-12"
  dayLabel: string;      // "Sa" / "Sat"
  fullDayLabel: string;  // "Samstag" / "Saturday"
  dateLabel: string;     // "12.07." / "07/12"
  context: string | null;
  isPeak: boolean;
  hours: ForecastHour[]; // 24 entries, index = local hour 0–23
}

// ─── Swiss local time helpers ────────────────────────────────────────────────

function swissOffset(utc: Date): number {
  // CET = UTC+1, CEST = UTC+2.  DST starts last Sunday of March, ends last Sunday of October.
  const y = utc.getUTCFullYear();
  const dstStart = lastSundayOf(y, 2); // March (0-indexed)
  const dstEnd   = lastSundayOf(y, 9); // October
  return utc >= dstStart && utc < dstEnd ? 2 : 1;
}

function lastSundayOf(year: number, month: number): Date {
  // Last day of month, then back to the most recent Sunday
  const last = new Date(Date.UTC(year, month + 1, 0));
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return last;
}

function toSwiss(utc: Date): Date {
  return new Date(utc.getTime() + swissOffset(utc) * 3_600_000);
}

// ─── Traffic profiles (0–10, per local hour 0–23) ────────────────────────────
// N_* = northIdx (southbound, CH→IT)   S_* = southIdx (northbound, IT→CH)

// Friday: heavy southbound exodus 07:00–17:00
const N_FRI = [0,0,0,0,0,0.5,1.5,4,7,9,10,9,8,7,6,5,4,3,2,1,0.5,0,0,0] as const;
// Saturday: morning rush southbound
const N_SAT = [0,0,0,0,0,0.5,1,3,5,7,7,6,5,4,3,2,1,0.5,0,0,0,0,0,0] as const;
// Sunday/weekday: low southbound
const N_SUN = [0,0,0,0,0,0,0.5,1,1.5,2,2,2,2,2,2,2,1.5,1,0.5,0,0,0,0,0] as const;
const N_WD  = [0,0,0,0,0,0,0.5,1,2,3,3,3,2.5,2.5,2.5,2,1,0.5,0,0,0,0,0,0] as const;

// Sunday: heavy northbound return 11:00–20:00
const S_SUN = [0,0,0,0,0,0,0.5,1,2,4,6,7,9,10,10,9,8,7,5,3,2,1,0.5,0] as const;
// Saturday afternoon: moderate northbound return
const S_SAT = [0,0,0,0,0,0,0.5,1,2,3,4,4,5,6,6,5,4,3,2,1,0.5,0,0,0] as const;
// Monday: some northbound return after long weekend
const S_MON = [0,0,0,0,0,0,0.5,1,2,4,5,5,4,3,2,1.5,1,0.5,0,0,0,0,0,0] as const;
const S_WD  = [0,0,0,0,0,0,0.5,1,1.5,2,2,2,2,2,2,2,1.5,1,0.5,0,0,0,0,0] as const;

type HProfile = readonly number[];

function profilesFor(dow: number): { n: HProfile; s: HProfile } {
  switch (dow) {
    case 5: return { n: N_FRI, s: S_WD };   // Friday: south exodus
    case 6: return { n: N_SAT, s: S_SAT };  // Saturday: mixed
    case 0: return { n: N_SUN, s: S_SUN };  // Sunday: north return
    case 1: return { n: N_WD,  s: S_MON };  // Monday: some late return
    default: return { n: N_WD,  s: S_WD };
  }
}

// ─── Season multiplier (0.2 winter … 1.0 peak summer) ────────────────────────
//                    Jan   Feb   Mar   Apr   May   Jun   Jul   Aug   Sep   Oct   Nov   Dec
const SEASON = [0.25, 0.25, 0.45, 0.65, 0.60, 0.75, 1.00, 1.00, 0.75, 0.60, 0.35, 0.25] as const;

// ─── Holiday boosts ───────────────────────────────────────────────────────────

interface HolidayPeriod {
  name: { de: string; en: string };
  matches: (m: number, d: number, dow: number) => boolean;
  boost: number;  // additive, so final = clamp(SEASON[m] + boost, 0, 1)
  // Key into the measured holiday multipliers in empirical-profiles.json. When set
  // and the data covered this period, the real per-direction multiplier is used
  // instead of the hand-tuned `boost`.
  empiricalKey?: string;
}

// Compute Easter Sunday for a given year (Anonymous Gregorian algorithm)
function easterSunday(year: number): Date {
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

function buildHolidayPeriods(year: number): HolidayPeriod[] {
  const easter = easterSunday(year);
  const eDateMs = easter.getTime();

  // Helper: is date within ±days of a reference date?
  const near = (refMs: number, before: number, after: number) =>
    (utcMs: number) => utcMs >= refMs - before * 86400_000 && utcMs < refMs + after * 86400_000;

  // Ascension = Easter + 39, Pentecost = Easter + 49
  const ascension = eDateMs + 39 * 86400_000;
  const pentecost = eDateMs + 49 * 86400_000;

  // Last Sunday of June (approximation for start of CH summer holidays)
  const juneLastSun = lastSundayOf(year, 5).getTime();

  return [
    {
      name: { de: 'Osterferien', en: 'Easter holidays' },
      matches: (m, d, _dow) => {
        const ms = Date.UTC(year, m - 1, d);
        return near(eDateMs, 5, 12)(ms);
      },
      boost: 0.3,
      empiricalKey: 'easter',
    },
    {
      name: { de: 'Tag der Arbeit (1. Mai)', en: 'Labour Day (1 May)' },
      matches: (m, d, _dow) => m === 5 && d >= 1 && d <= 3,
      boost: 0.25,
      empiricalKey: 'labourday',
    },
    {
      name: { de: 'Auffahrt / Pfingsten', en: 'Ascension / Pentecost' },
      matches: (m, d, _dow) => {
        const ms = Date.UTC(year, m - 1, d);
        return near(ascension, 1, 4)(ms) || near(pentecost, 1, 4)(ms);
      },
      boost: 0.25,
    },
    {
      name: { de: 'Schulferien CH / Sommer', en: 'CH/DE school summer holidays' },
      matches: (m, _d, _dow) => m >= 7 && m <= 8,
      boost: 0.5,
    },
    {
      name: { de: 'Ferienstart (Pfingsten / Juni)', en: 'Early summer (pre-holidays)' },
      matches: (m, d, _dow) => {
        const ms = Date.UTC(year, m - 1, d);
        return m === 6 && ms >= juneLastSun;
      },
      boost: 0.3,
    },
    {
      name: { de: 'Nationalfeiertag CH (1. August)', en: 'Swiss National Day (1 Aug)' },
      matches: (m, d, _dow) => m === 8 && d >= 1 && d <= 3,
      boost: 0.5,
    },
    {
      name: { de: 'Mariä Himmelfahrt (15. August)', en: 'Assumption Day (15 Aug)' },
      matches: (m, d, _dow) => m === 8 && d >= 14 && d <= 17,
      boost: 0.35,
    },
    {
      name: { de: 'Herbstferien', en: 'Autumn school holidays' },
      matches: (m, d, _dow) => m === 10 && d >= 3 && d <= 19,
      boost: 0.2,
    },
    {
      name: { de: 'Weihnachtsferien', en: 'Christmas holidays' },
      matches: (m, d, _dow) => (m === 12 && d >= 22) || (m === 1 && d <= 6),
      boost: 0.25,
    },
  ];
}

// ─── Index → level ────────────────────────────────────────────────────────────

function toLevel(idx: number): TrafficLevel {
  if (idx >= 6.5) return 'extreme';
  if (idx >= 3.5) return 'high';
  if (idx >= 1.5) return 'moderate';
  return 'low';
}

// Convert a 0–10 congestion index into an estimated waiting time in minutes.
// idx 10 ≈ 90 min (matches "10 km / 90+ min" at the top of the model).
export function idxToWaitMinutes(idx: number): number {
  return Math.round(Math.max(0, idx) * 9);
}

// ─── Day/date labels ──────────────────────────────────────────────────────────

const SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const LONG_DE  = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'] as const;
const SHORT_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const;
const LONG_EN  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] as const;

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// ─── Per-day model (shared by the heatmap and the 10-minute curve) ────────────

interface DayModel {
  isoDate: string;
  dayLabel: string;
  fullDayLabel: string;
  dateLabel: string;
  context: string | null;
  mult: number;
  nProf: HProfile;
  sProf: HProfile;
}

// UTC moment corresponding to midnight (00:00) in Zurich for the given instant.
function swissMidnightUTC(from: Date): Date {
  const swissNow = toSwiss(from);
  const dayStart = new Date(Date.UTC(
    swissNow.getUTCFullYear(), swissNow.getUTCMonth(), swissNow.getUTCDate()
  ));
  return new Date(dayStart.getTime() - swissOffset(from) * 3_600_000);
}

function computeDayModel(dayUTC: Date, holidays: HolidayPeriod[], lang: 'de' | 'en'): DayModel {
  const daySwiss = toSwiss(dayUTC);
  const year  = daySwiss.getUTCFullYear();
  const month = daySwiss.getUTCMonth() + 1; // 1-12
  const dom   = daySwiss.getUTCDate();
  const dow   = daySwiss.getUTCDay(); // 0=Sun

  const matchedHoliday = holidays.find(h => h.matches(month, dom, dow));
  const seasonMult = SEASON[month - 1];
  const boost = matchedHoliday?.boost ?? 0;

  // Prefer real observed profiles for this weekday when the history covered it.
  // The empirical base magnitudes sit at the observed spring `seasonBaseline`, so
  // scale to the target month, and apply the holiday effect per direction —
  // measured from the data where available, else derived from the model boost.
  const seasonScale = seasonMult / seasonBaseline;
  const additiveMult = seasonMult > 0
    ? Math.min(1.3, seasonMult + boost) / seasonMult
    : 1;
  const measured = measuredHolidayMult(matchedHoliday?.empiricalKey);
  const holMultN = measured ? measured.n : additiveMult;
  const holMultS = measured ? measured.s : additiveMult;
  const empirical = empiricalDayProfiles(dow, seasonScale, holMultN, holMultS);

  // Empirical profiles are already fully scaled, so `mult` collapses to 1.
  const mult = empirical ? 1 : Math.min(1.3, seasonMult + boost);
  const { n: nProf, s: sProf } = empirical ?? profilesFor(dow);

  return {
    isoDate: `${year}-${pad2(month)}-${pad2(dom)}`,
    dayLabel: lang === 'de' ? SHORT_DE[dow] : SHORT_EN[dow],
    fullDayLabel: lang === 'de' ? LONG_DE[dow] : LONG_EN[dow],
    dateLabel: lang === 'de' ? `${pad2(dom)}.${pad2(month)}.` : `${pad2(month)}/${pad2(dom)}`,
    context: matchedHoliday ? matchedHoliday.name[lang] : null,
    mult,
    nProf,
    sProf,
  };
}

// Congestion index (0–10) at a fractional minute-of-day, linearly interpolating
// between the hourly profile samples. This is what gives us 10-minute resolution.
function indexAt(prof: HProfile, mult: number, minuteOfDay: number): number {
  const hf = minuteOfDay / 60;             // 0–24
  const h0 = Math.floor(hf) % 24;
  const h1 = (h0 + 1) % 24;
  const frac = hf - Math.floor(hf);
  const raw = prof[h0] + (prof[h1] - prof[h0]) * frac;
  return Math.min(10, raw * mult);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateForecast(from: Date, lang: 'de' | 'en' = 'de', days = 4): ForecastDay[] {
  const allHolidays = [
    ...buildHolidayPeriods(from.getUTCFullYear()),
    ...buildHolidayPeriods(from.getUTCFullYear() + 1), // in case we cross a year boundary
  ];

  const dayStartUTC = swissMidnightUTC(from);
  const result: ForecastDay[] = [];

  for (let dayOff = 0; dayOff < days; dayOff++) {
    const dayUTC = new Date(dayStartUTC.getTime() + dayOff * 86_400_000);
    const model = computeDayModel(dayUTC, allHolidays, lang);

    const hours: ForecastHour[] = [];
    for (let h = 0; h < 24; h++) {
      const northIdx = +indexAt(model.nProf, model.mult, h * 60).toFixed(1);
      const southIdx = +indexAt(model.sProf, model.mult, h * 60).toFixed(1);
      hours.push({
        localHour: h,
        northIdx,
        southIdx,
        northLevel: toLevel(northIdx),
        southLevel: toLevel(southIdx),
      });
    }

    const isPeak = hours.some(h => h.northIdx >= 3.5 || h.southIdx >= 3.5);
    const { isoDate, dayLabel, fullDayLabel, dateLabel, context } = model;
    result.push({ isoDate, dayLabel, fullDayLabel, dateLabel, context, isPeak, hours });
  }

  return result;
}

// ─── 10-minute-resolution wait-time curve for a single day ────────────────────

export interface ForecastPoint {
  minuteOfDay: number; // 0–1440
  northIdx: number;
  southIdx: number;
  northWait: number;   // estimated wait minutes, north portal (Göschenen)
  southWait: number;   // estimated wait minutes, south portal (Airolo)
}

export interface DayCurve {
  isoDate: string;
  fullDayLabel: string;
  dateLabel: string;
  context: string | null;
  points: ForecastPoint[];
}

/**
 * Predicted wait-time curve for the Swiss-local day containing `from`,
 * sampled every `stepMin` minutes (default 10) from 00:00 to 24:00 inclusive.
 */
export function generateDayCurve(from: Date, lang: 'de' | 'en' = 'de', stepMin = 10): DayCurve {
  const allHolidays = [
    ...buildHolidayPeriods(from.getUTCFullYear()),
    ...buildHolidayPeriods(from.getUTCFullYear() + 1),
  ];
  const dayUTC = swissMidnightUTC(from);
  const model = computeDayModel(dayUTC, allHolidays, lang);

  const points: ForecastPoint[] = [];
  for (let m = 0; m <= 1440; m += stepMin) {
    const northIdx = indexAt(model.nProf, model.mult, m);
    const southIdx = indexAt(model.sProf, model.mult, m);
    points.push({
      minuteOfDay: m,
      northIdx: +northIdx.toFixed(2),
      southIdx: +southIdx.toFixed(2),
      northWait: idxToWaitMinutes(northIdx),
      southWait: idxToWaitMinutes(southIdx),
    });
  }

  return {
    isoDate: model.isoDate,
    fullDayLabel: model.fullDayLabel,
    dateLabel: model.dateLabel,
    context: model.context,
    points,
  };
}

// ─── Swiss-local day helpers (used to align live history to the curve) ────────

export interface SwissDayInfo {
  isoDate: string;     // "2026-07-14" in Zurich local time
  minuteOfDay: number; // 0–1439
}

export function swissDayInfo(instant: Date): SwissDayInfo {
  const s = toSwiss(instant);
  return {
    isoDate: `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`,
    minuteOfDay: s.getUTCHours() * 60 + s.getUTCMinutes(),
  };
}
