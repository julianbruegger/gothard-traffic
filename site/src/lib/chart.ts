import type { HistoryPoint } from './types';

export interface TimeTick {
  x: number;
  label: string;
}

/** A history sample's pixel position, for hover interaction. */
export interface ChartPoint {
  x: number;
  yNorth: number;
  ySouth: number;
  t: string;
  north: number | null;
  south: number | null;
}

/** A horizontal band marking a period during which the tunnel was closed. */
export interface ClosureBand {
  x1: number;
  x2: number;
}

export interface SparklineResult {
  northPath: string;
  southPath: string;
  width: number;
  height: number;
  maxKm: number;
  ticks: TimeTick[];
  points: ChartPoint[];
  closures: ClosureBand[];
}

const PADDING_X = 8;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 24; // space for time labels

export function buildSparkline(history: HistoryPoint[], width = 640, height = 220): SparklineResult {
  if (history.length === 0) {
    return { northPath: '', southPath: '', width, height, maxKm: 0, ticks: [], points: [], closures: [] };
  }

  const maxKm = Math.max(1, ...history.map((p) => Math.max(p.northQueueKm ?? 0, p.southQueueKm ?? 0)));
  const innerW = width - PADDING_X * 2;
  const innerH = height - PADDING_TOP - PADDING_BOTTOM;

  const times = history.map((p) => Date.parse(p.t));
  const tMin = times[0];
  const tMax = times[times.length - 1];
  const tSpan = Math.max(tMax - tMin, 1);

  const xOf = (i: number) => PADDING_X + (innerW * (times[i] - tMin)) / tSpan;
  const yOf = (km: number) => PADDING_TOP + innerH - (km / maxKm) * innerH;

  const toPath = (key: 'northQueueKm' | 'southQueueKm') =>
    history
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(p[key] ?? 0).toFixed(1)}`)
      .join(' ');

  // Time axis ticks — adaptive interval so there are always 2–8 ticks
  const ticks: TimeTick[] = [];
  const hours = tSpan / 3_600_000;
  const tickH = hours <= 4 ? 1 : hours <= 12 ? 2 : hours <= 30 ? 6 : 12;
  const tickMs = tickH * 3_600_000;
  const firstTick = Math.ceil(tMin / tickMs) * tickMs;
  for (let ts = firstTick; ts <= tMax; ts += tickMs) {
    const x = PADDING_X + (innerW * (ts - tMin)) / tSpan;
    const d = new Date(ts);
    const h = (d.getUTCHours() + 2) % 24; // approx CEST
    const label = tickH < 6 ? `${String(h).padStart(2, '0')}:00` : `${String(h).padStart(2, '0')}h`;
    ticks.push({ x: +x.toFixed(1), label });
  }

  // Closure bands: each sample flagged `closed` covers the span from the
  // midpoint to its previous neighbour up to the midpoint to its next one, so a
  // lone closed sample still renders as a visible band. Adjacent bands merge.
  const closures: ClosureBand[] = [];
  history.forEach((p, i) => {
    if (p.status !== 'closed') return;
    const left = i === 0 ? xOf(0) : (xOf(i - 1) + xOf(i)) / 2;
    const right = i === history.length - 1 ? xOf(i) : (xOf(i) + xOf(i + 1)) / 2;
    const prev = closures[closures.length - 1];
    if (prev && left - prev.x2 <= 0.5) {
      prev.x2 = right;
    } else {
      closures.push({ x1: +left.toFixed(1), x2: +right.toFixed(1) });
    }
  });
  for (const band of closures) {
    band.x1 = +band.x1.toFixed(1);
    band.x2 = +band.x2.toFixed(1);
  }

  const points: ChartPoint[] = history.map((p, i) => ({
    x: +xOf(i).toFixed(1),
    yNorth: +yOf(p.northQueueKm ?? 0).toFixed(1),
    ySouth: +yOf(p.southQueueKm ?? 0).toFixed(1),
    t: p.t,
    north: p.northQueueKm ?? null,
    south: p.southQueueKm ?? null,
  }));

  return {
    northPath: toPath('northQueueKm'),
    southPath: toPath('southQueueKm'),
    width,
    height,
    maxKm,
    ticks,
    points,
    closures,
  };
}
