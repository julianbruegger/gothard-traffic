// Forecast model for Gotthard Tunnel traffic.
// Predicts typical congestion based on weekday, season, and CH/DE/AT/IT holiday calendar.
//
// northIdx = expected queue at Nordportal Göschenen  (southbound, CH/DE → Italy)
// southIdx = expected queue at Südportal Airolo      (northbound, Italy → CH/DE)
// Index 0 = no queue, 10 = extreme jam (>10 km / 90+ min)

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

// ─── Day/date labels ──────────────────────────────────────────────────────────

const SHORT_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;
const LONG_DE  = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'] as const;
const SHORT_EN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] as const;
const LONG_EN  = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'] as const;

function pad2(n: number): string { return String(n).padStart(2, '0'); }

// ─── Public API ───────────────────────────────────────────────────────────────

export function generateForecast(from: Date, lang: 'de' | 'en' = 'de', days = 4): ForecastDay[] {
  const holidays = buildHolidayPeriods(from.getUTCFullYear());
  // Also build for next year in case we cross a year boundary
  const holidays2 = buildHolidayPeriods(from.getUTCFullYear() + 1);
  const allHolidays = [...holidays, ...holidays2];

  const result: ForecastDay[] = [];

  // Align to start of current Swiss local day (midnight)
  const swissNow = toSwiss(from);
  const dayStart = new Date(Date.UTC(
    swissNow.getUTCFullYear(), swissNow.getUTCMonth(), swissNow.getUTCDate()
  ));
  // dayStart is the UTC moment corresponding to midnight in Zurich
  const offset = swissOffset(from);
  const dayStartUTC = new Date(dayStart.getTime() - offset * 3_600_000);

  for (let dayOff = 0; dayOff < days; dayOff++) {
    const dayUTC = new Date(dayStartUTC.getTime() + dayOff * 86_400_000);
    const daySwiss = toSwiss(dayUTC);

    const year  = daySwiss.getUTCFullYear();
    const month = daySwiss.getUTCMonth() + 1; // 1-12
    const dom   = daySwiss.getUTCDate();
    const dow   = daySwiss.getUTCDay(); // 0=Sun

    const isoDate  = `${year}-${pad2(month)}-${pad2(dom)}`;
    const dayLabel = lang === 'de' ? SHORT_DE[dow] : SHORT_EN[dow];
    const fullDayLabel = lang === 'de' ? LONG_DE[dow] : LONG_EN[dow];
    const dateLabel = lang === 'de'
      ? `${pad2(dom)}.${pad2(month)}.`
      : `${pad2(month)}/${pad2(dom)}`;

    // Holiday context
    const matchedHoliday = allHolidays.find(h => h.matches(month, dom, dow));
    const context = matchedHoliday ? matchedHoliday.name[lang] : null;

    const seasonMult = SEASON[month - 1];
    const holidayBoost = matchedHoliday?.boost ?? 0;
    const mult = Math.min(1.3, seasonMult + holidayBoost);

    const { n: nProf, s: sProf } = profilesFor(dow);

    const hours: ForecastHour[] = [];
    for (let h = 0; h < 24; h++) {
      const northIdx = +(Math.min(10, nProf[h] * mult * 10)).toFixed(1);
      const southIdx = +(Math.min(10, sProf[h] * mult * 10)).toFixed(1);
      hours.push({
        localHour: h,
        northIdx,
        southIdx,
        northLevel: toLevel(northIdx),
        southLevel: toLevel(southIdx),
      });
    }

    const isPeak = hours.some(h => h.northIdx >= 3.5 || h.southIdx >= 3.5);

    result.push({ isoDate, dayLabel, fullDayLabel, dateLabel, context, isPeak, hours });
  }

  return result;
}
