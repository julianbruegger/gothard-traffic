import type { ForecastPoint } from './forecast';

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

export interface ForecastChartResult {
  width: number;
  height: number;
  maxMin: number;         // top of the y-axis (wait minutes)
  nowX: number | null;    // x of the "now" marker, or null if not applicable
  plot: PlotBox;
  xTicks: AxisTick[];
  yTicks: AxisTick[];
  northForecast: string;  // dashed — predicted
  southForecast: string;
  northActual: string;    // solid — measured so far today
  southActual: string;
}

const PADDING_LEFT = 34;   // room for y-axis labels
const PADDING_RIGHT = 10;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 22; // room for hour labels

/**
 * Build the SVG geometry for the "today" wait-time prediction chart:
 * dashed forecast lines across the whole day, plus solid measured lines up to `nowMin`.
 */
export function buildForecastChart(
  forecast: ForecastPoint[],
  actual: ActualPoint[],
  nowMin: number | null,
  width = 640,
  height = 260,
): ForecastChartResult {
  const innerW = width - PADDING_LEFT - PADDING_RIGHT;
  const innerH = height - PADDING_TOP - PADDING_BOTTOM;

  // Y scale: at least 60 min, rounded up to a clean 30-min step above the peak.
  const peak = Math.max(
    0,
    ...forecast.map((p) => Math.max(p.northWait, p.southWait)),
    ...actual.map((p) => Math.max(p.north ?? 0, p.south ?? 0)),
  );
  const maxMin = Math.max(60, Math.ceil((peak * 1.1) / 30) * 30);

  const xOf = (minuteOfDay: number) => PADDING_LEFT + (innerW * minuteOfDay) / 1440;
  const yOf = (min: number) => PADDING_TOP + innerH - (Math.min(min, maxMin) / maxMin) * innerH;

  const linePath = (pts: Array<{ x: number; y: number }>) =>
    pts.length === 0
      ? ''
      : pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  const forecastPath = (key: 'northWait' | 'southWait') =>
    linePath(forecast.map((p) => ({ x: xOf(p.minuteOfDay), y: yOf(p[key]) })));

  // Measured lines only run up to "now" and skip gaps where the value is null.
  const actualPath = (key: 'north' | 'south') => {
    const pts = actual
      .filter((p) => (nowMin === null || p.minuteOfDay <= nowMin) && p[key] !== null)
      .map((p) => ({ x: xOf(p.minuteOfDay), y: yOf(p[key] as number) }));
    return linePath(pts);
  };

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
    northForecast: forecastPath('northWait'),
    southForecast: forecastPath('southWait'),
    northActual: actualPath('north'),
    southActual: actualPath('south'),
  };
}
