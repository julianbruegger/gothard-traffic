import { generateForecast } from './forecast';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DayPoint {
  date: string;         // "YYYY-MM-DD"
  northMinutes: number; // expected peak north wait (0–50 min)
  southMinutes: number; // expected peak south wait (0–50 min)
}

export interface YearSeries {
  year: number;
  points: DayPoint[];
}

export interface YearlyChartResult {
  svgWidth: number;
  svgHeight: number;
  lines: YearLineSpec[];
  bandPath: string;
  gridLines: GridLine[];
  xTicks: XTick[];
}

interface YearLineSpec {
  year: number;
  color: string;
  strokeDasharray: string | null;
  path: string;
}

interface GridLine {
  y: number;
  x1: number;
  x2: number;
  labelX: number;
  labelY: number;
  label: string;
}

interface XTick {
  x: number;
  label: string;
  y: number;
}

// ─── Date range: June 1 – September 30 ───────────────────────────────────────

const RANGE_START_MM = 6;  // June
const RANGE_START_DD = 1;
const RANGE_END_MM   = 9;  // September
const RANGE_END_DD   = 30;

// ─── Chart layout ─────────────────────────────────────────────────────────────

const Y_MAX  = 50;
const Y_STEP = 10;

const SVG_W = 800;
const SVG_H = 260;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 14;
const PAD_B = 28;

const INNER_W = SVG_W - PAD_L - PAD_R;
const INNER_H = SVG_H - PAD_T - PAD_B;

const YEAR_SPECS: Record<number, { color: string; dash: string | null }> = {
  2023: { color: '#94a3b8', dash: null },
  2024: { color: '#e879f9', dash: null },
  2025: { color: '#c084fc', dash: null },
  2026: { color: '#a3e635', dash: '6 4' },
};

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toISO(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Returns all dates (as ISO strings) from Jun 1 to Sep 30 for the given year */
function getDatesInRange(year: number): string[] {
  const dates: string[] = [];
  const start = new Date(Date.UTC(year, RANGE_START_MM - 1, RANGE_START_DD));
  const end   = new Date(Date.UTC(year, RANGE_END_MM - 1, RANGE_END_DD));
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }
  return dates;
}


// ─── Coordinate helpers ───────────────────────────────────────────────────────

function xOfIndex(idx: number, total: number): number {
  return PAD_L + (INNER_W * idx) / Math.max(total - 1, 1);
}

function yOf(min: number): number {
  return PAD_T + INNER_H * (1 - min / Y_MAX);
}

// ─── Model fallback ───────────────────────────────────────────────────────────

function modelDayPoint(date: string): DayPoint {
  const [y, m, d] = date.split('-').map(Number);
  const utc  = new Date(Date.UTC(y, m - 1, d));
  const days = generateForecast(utc, 'de', 1);
  if (days.length === 0) return { date, northMinutes: 0, southMinutes: 0 };
  const hours = days[0].hours;
  const northMinutes = Math.round(Math.min(Y_MAX, Math.max(...hours.map(h => h.northIdx)) * 5));
  const southMinutes = Math.round(Math.min(Y_MAX, Math.max(...hours.map(h => h.southIdx)) * 5));
  return { date, northMinutes, southMinutes };
}

// ─── Series builder ───────────────────────────────────────────────────────────

function buildYearSeries(
  year: number,
  historical: DayPoint[] | null,
): YearSeries {
  const dates = getDatesInRange(year);
  const lookup = new Map(historical?.map(p => [p.date, p]) ?? []);
  const points = dates.map(date => lookup.get(date) ?? modelDayPoint(date));
  return { year, points };
}

// ─── SVG path builders ────────────────────────────────────────────────────────

function seriesToPath(series: YearSeries): string {
  const pts = series.points;
  return pts
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOfIndex(i, pts.length).toFixed(1)},${yOf(p.southMinutes).toFixed(1)}`)
    .join(' ');
}

function buildBandPath(series: YearSeries[]): string {
  const count = series[0].points.length;
  const mins: number[] = [];
  const maxs: number[] = [];
  for (let i = 0; i < count; i++) {
    const vals = series.map(s => s.points[i].southMinutes);
    mins.push(Math.min(...vals));
    maxs.push(Math.max(...vals));
  }
  const fwd = maxs.map((m, i) => `${i === 0 ? 'M' : 'L'}${xOfIndex(i, count).toFixed(1)},${yOf(m).toFixed(1)}`);
  const bwd = Array.from({ length: count }, (_, i) => {
    const ii = count - 1 - i;
    return `L${xOfIndex(ii, count).toFixed(1)},${yOf(mins[ii]).toFixed(1)}`;
  });
  return `${fwd.join(' ')} ${bwd.join(' ')} Z`;
}

// ─── Grid lines ───────────────────────────────────────────────────────────────

function buildGridLines(): GridLine[] {
  const lines: GridLine[] = [];
  for (let min = 0; min <= Y_MAX; min += Y_STEP) {
    const y = +yOf(min).toFixed(1);
    lines.push({ y, x1: PAD_L, x2: SVG_W - PAD_R, labelX: PAD_L - 6, labelY: +(y + 4).toFixed(1), label: String(min) });
  }
  return lines;
}

// ─── X-axis ticks: 1st of each month + 15th of July/August ──────────────────

const MONTH_DE = ['','Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const MONTH_EN = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildXTicks(lang: 'de' | 'en'): XTick[] {
  const refYear  = 2026;
  const allDates = getDatesInRange(refYear);
  const total    = allDates.length;
  const months   = RANGE_START_MM > RANGE_END_MM
    ? [] : Array.from({ length: RANGE_END_MM - RANGE_START_MM + 1 }, (_, i) => RANGE_START_MM + i);

  const ticks: XTick[] = [];
  const y = PAD_T + INNER_H + 17;

  for (const month of months) {
    // 1st of each month
    for (const day of [1, 15]) {
      if (month === RANGE_START_MM && day < RANGE_START_DD) continue;
      if (month === RANGE_END_MM && day > RANGE_END_DD) continue;
      const iso = toISO(refYear, month, day);
      const idx = allDates.indexOf(iso);
      if (idx === -1) continue;
      const months_arr = lang === 'de' ? MONTH_DE : MONTH_EN;
      const label = day === 1
        ? `${months_arr[month]}`
        : `15. ${months_arr[month]}`;
      ticks.push({ x: +xOfIndex(idx, total).toFixed(1), label, y });
    }
  }
  return ticks;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function buildYearlyChart(
  historicalData: Record<string, DayPoint[]> | null,
  lang: 'de' | 'en' = 'de',
): YearlyChartResult {
  const s2023 = buildYearSeries(2023, historicalData?.['2023'] ?? null);
  const s2024 = buildYearSeries(2024, historicalData?.['2024'] ?? null);
  const s2025 = buildYearSeries(2025, historicalData?.['2025'] ?? null);
  const s2026 = buildYearSeries(2026, null);

  const lines: YearLineSpec[] = [s2023, s2024, s2025, s2026].map(s => ({
    year:            s.year,
    color:           YEAR_SPECS[s.year].color,
    strokeDasharray: YEAR_SPECS[s.year].dash,
    path:            seriesToPath(s),
  }));

  return {
    svgWidth:  SVG_W,
    svgHeight: SVG_H,
    lines,
    bandPath:  buildBandPath([s2023, s2024, s2025]),
    gridLines: buildGridLines(),
    xTicks:    buildXTicks(lang),
  };
}
