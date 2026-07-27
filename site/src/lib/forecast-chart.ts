import type { ForecastPoint } from './forecast';
import type { HistoricDaySeries } from './historic-days';

export type Direction = 'north' | 'south';

// A measured wait-time sample, aligned to minutes-of-day in Swiss local time.
export interface ActualPoint {
  minuteOfDay: number;
  north: number | null;
  south: number | null;
}

export interface AxisTick {
  x?: number;
  y?: number;
  label: string;
}

export interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface HistoricLine {
  isoDate: string;
  color: string;
  path: string;
  values: number[]; // wait minutes, aligned with the forecast grid — used by hover
}

export interface ForecastChartResult {
  width: number;
  height: number;
  maxMin: number;         // top of the y-axis (wait minutes)
  nowX: number | null;    // x of the "now" marker, or null if not applicable
  plot: PlotBox;
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  forecastPath: string;    // dashed — typical predicted day, selected direction
  forecastHighPath: string; // faint upper edge — busy-day prediction
  forecastBandPath: string; // shaded typical→busy range for the selected direction
  actualPath: string;      // solid — measured so far today, selected direction
  bandPath: string | null; // shaded min/max envelope across the historic lines
  historic: HistoricLine[];
}

const PADDING_LEFT = 34;   // room for y-axis labels
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 22; // room for hour labels

// Muted violet palette for historic weeks, most recent first — fades with age.
const HISTORIC_COLORS = ['rgba(139, 92, 246, 0.85)', 'rgba(99, 102, 241, 0.6)', 'rgba(14, 165, 233, 0.45)'];

/**
 * Build the SVG geometry for the wait-time prediction chart: a dashed forecast
 * line for the selected direction, a solid measured line up to `nowMin` (today
 * only), and up to a few real historic same-weekday lines with a shaded
 * min/max band behind them.
 */
export function buildForecastChart(
  forecast: ForecastPoint[],
  actual: ActualPoint[],
  nowMin: number | null,
  direction: Direction,
  historic: HistoricDaySeries[],
  width = 640,
  height = 260,
): ForecastChartResult {
  const innerW = width - PADDING_LEFT - PADDING_RIGHT;
  const innerH = height - PADDING_TOP - PADDING_BOTTOM;

  const forecastKey = direction === 'north' ? 'northWait' : 'southWait';
  const highKey = direction === 'north' ? 'northWaitHigh' : 'southWaitHigh';
  const actualKey = direction;

  // Y scale: at least 60 min, rounded up to a clean 30-min step above the peak.
  // Includes the busy-day upper edge so the range band is never clipped.
  const peak = Math.max(
    0,
    ...forecast.map((p) => p[highKey]),
    ...actual.map((p) => p[actualKey] ?? 0),
    ...historic.flatMap((h) => h.waitMinutes),
  );
  const maxMin = Math.max(60, Math.ceil((peak * 1.1) / 30) * 30);

  const xOf = (minuteOfDay: number) => PADDING_LEFT + (innerW * minuteOfDay) / 1440;
  const yOf = (min: number) => PADDING_TOP + innerH - (Math.min(min, maxMin) / maxMin) * innerH;

  const linePath = (pts: Array<{ x: number; y: number }>) =>
    pts.length === 0
      ? ''
      : pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const forecastPath = linePath(forecast.map((p) => ({ x: xOf(p.minuteOfDay), y: yOf(p[forecastKey]) })));
  const forecastHighPath = linePath(forecast.map((p) => ({ x: xOf(p.minuteOfDay), y: yOf(p[highKey]) })));

  // Shaded range between the typical line (lower) and the busy-day line (upper):
  // forward along the busy edge, back along the typical edge, closed.
  const forecastBandPath = (() => {
    if (forecast.length === 0) return '';
    const hi = forecast.map((p) => `${xOf(p.minuteOfDay).toFixed(1)},${yOf(p[highKey]).toFixed(1)}`);
    const lo = forecast
      .map((p) => `${xOf(p.minuteOfDay).toFixed(1)},${yOf(p[forecastKey]).toFixed(1)}`)
      .reverse();
    return `M${hi.join(' L')} L${lo.join(' L')} Z`;
  })();

  // Measured line only runs up to "now" (today) and skips gaps where the value is null.
  const actualPath = linePath(
    actual
      .filter((p) => (nowMin === null || p.minuteOfDay <= nowMin) && p[actualKey] !== null)
      .map((p) => ({ x: xOf(p.minuteOfDay), y: yOf(p[actualKey] as number) })),
  );

  const historicLines: HistoricLine[] = historic.map((h, i) => ({
    isoDate: h.isoDate,
    color: HISTORIC_COLORS[i % HISTORIC_COLORS.length],
    path: linePath(h.waitMinutes.map((v, idx) => ({ x: xOf(forecast[idx].minuteOfDay), y: yOf(v) }))),
    values: h.waitMinutes,
  }));

  // Shaded min/max band across the historic lines, so the current forecast can
  // be read against the real spread of past same-weekday days.
  let bandPath: string | null = null;
  if (historic.length > 0) {
    const count = historic[0].waitMinutes.length;
    const mins: number[] = [];
    const maxs: number[] = [];
    for (let i = 0; i < count; i++) {
      const vals = historic.map((h) => h.waitMinutes[i]);
      mins.push(Math.min(...vals));
      maxs.push(Math.max(...vals));
    }
    const fwd = maxs.map((m, i) => `${i === 0 ? 'M' : 'L'}${xOf(forecast[i].minuteOfDay).toFixed(1)},${yOf(m).toFixed(1)}`);
    const bwd = Array.from({ length: count }, (_, i) => {
      const ii = count - 1 - i;
      return `L${xOf(forecast[ii].minuteOfDay).toFixed(1)},${yOf(mins[ii]).toFixed(1)}`;
    });
    bandPath = `${fwd.join(' ')} ${bwd.join(' ')} Z`;
  }

  // X ticks every 3 hours (00, 03, … 24)
  const xTicks: AxisTick[] = [];
  for (let h = 0; h <= 24; h += 3) {
    xTicks.push({ x: +xOf(h * 60).toFixed(1), label: `${String(h % 24).padStart(2, '0')}` });
  }

  // Y ticks at 0, ¼, ½, ¾, max
  const yTicks: AxisTick[] = [];
  for (let i = 0; i <= 4; i++) {
    const val = (maxMin / 4) * i;
    yTicks.push({ y: +yOf(val).toFixed(1), label: `${Math.round(val)}` });
  }

  return {
    width,
    height,
    maxMin,
    nowX: nowMin === null ? null : +xOf(nowMin).toFixed(1),
    plot: {
      left: PADDING_LEFT,
      right: width - PADDING_RIGHT,
      top: PADDING_TOP,
      bottom: height - PADDING_BOTTOM,
    },
    xTicks,
    yTicks,
    forecastPath,
    forecastHighPath,
    forecastBandPath,
    actualPath,
    bandPath,
    historic: historicLines,
  };
}
