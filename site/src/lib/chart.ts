import type { HistoryPoint } from './types';

export interface TimeTick {
  x: number;
  label: string;
}

/** A resampled bucket's pixel position, for hover interaction. */
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
  /** Dotted connectors across tunnel closures (no reading, queue still there). */
  northGapPath: string;
  southGapPath: string;
  width: number;
  height: number;
  maxKm: number;
  ticks: TimeTick[];
  /** Horizontal gridlines at 0, ½ and the top of the (rounded) km scale. */
  yTicks: Array<{ y: number; km: number }>;
  points: ChartPoint[];
  closures: ClosureBand[];
}

const DEFAULT_PADDING_X = 8;
const DEFAULT_PADDING_TOP = 8;
const DEFAULT_PADDING_BOTTOM = 24; // space for time labels

// The chart always covers a fixed trailing window (matches the "last 24 hours"
// heading) so the x-axis is stable regardless of how far back the feed reaches.
const WINDOW_MS = 24 * 60 * 60_000;
// Raw samples arrive roughly every 10-15 min at irregular spacing, which makes a
// raw line zig-zag and turns isolated readings into disconnected dots. We instead
// resample into fixed buckets and average every reading inside each one: the line
// reads as a trend, spikes get smoothed toward reality, and evenly-spaced buckets
// draw a continuous line instead of a dotted baseline.
const BUCKET_MS = 30 * 60_000;
// Bridge gaps so the line stays continuous even when the feed is patchy (the
// point of averaging: draw the trend we do have rather than a fragmented dotted
// mess). Only a genuinely long outage (> 3h with no reading at all) breaks it.
const MAX_BRIDGE_MS = 3 * 60 * 60_000;

interface Bucket {
  center: number;
  north: number | null;
  south: number | null;
  closed: boolean;
}

export interface SparklineOptions {
  padX?: number;
  padTop?: number;
  padBottom?: number;
  /** Lower bound for the y-axis top, so a 0.3 km queue doesn't fill the chart. */
  minMaxKm?: number;
}

export function buildSparkline(history: HistoryPoint[], width = 640, height = 220, opts: SparklineOptions = {}): SparklineResult {
  const PADDING_X = opts.padX ?? DEFAULT_PADDING_X;
  const PADDING_TOP = opts.padTop ?? DEFAULT_PADDING_TOP;
  const PADDING_BOTTOM = opts.padBottom ?? DEFAULT_PADDING_BOTTOM;
  const empty: SparklineResult = {
    northPath: '', southPath: '', northGapPath: '', southGapPath: '', width, height, maxKm: 0, ticks: [], yTicks: [], points: [], closures: [],
  };
  if (history.length === 0) return empty;

  // Fixed trailing window ending at the newest reading (not wall-clock "now", so
  // the chart still fills even if the feed briefly stops updating).
  const times = history.map((p) => Date.parse(p.t));
  const end = Math.max(...times);
  const start = end - WINDOW_MS;
  const tSpan = WINDOW_MS;

  const innerW = width - PADDING_X * 2;
  const innerH = height - PADDING_TOP - PADDING_BOTTOM;
  const xOf = (t: number) => PADDING_X + (innerW * (t - start)) / tSpan;

  // ── Resample the window into fixed buckets, averaging each side's readings ──
  const bucketCount = Math.ceil(WINDOW_MS / BUCKET_MS);
  const acc = Array.from({ length: bucketCount }, () => ({
    nSum: 0, nCount: 0, sSum: 0, sCount: 0, closed: false,
  }));
  history.forEach((p, i) => {
    const t = times[i];
    if (t < start || t > end) return;
    const bi = Math.min(bucketCount - 1, Math.floor((t - start) / BUCKET_MS));
    const b = acc[bi];
    // While the tunnel is closed the feed reports 0 km, but the queue in front of
    // the barrier keeps building: treat it as "no reading", not as an empty road.
    if (p.status === 'closed') { b.closed = true; return; }
    if (p.northQueueKm !== null && p.northQueueKm !== undefined) { b.nSum += p.northQueueKm; b.nCount++; }
    if (p.southQueueKm !== null && p.southQueueKm !== undefined) { b.sSum += p.southQueueKm; b.sCount++; }
  });

  const buckets: Bucket[] = acc.map((b, bi) => ({
    center: start + (bi + 0.5) * BUCKET_MS,
    north: b.nCount ? b.nSum / b.nCount : null,
    south: b.sCount ? b.sSum / b.sCount : null,
    closed: b.closed,
  }));

  const rawMax = Math.max(
    opts.minMaxKm ?? 2,
    ...buckets.map((b) => Math.max(b.north ?? 0, b.south ?? 0)),
  );
  // Round the scale up to a value whose half is a whole number of km.
  const maxKm = [2, 4, 6, 10, 20, 30, 40, 60].find((m) => m >= rawMax) ?? Math.ceil(rawMax / 20) * 20;
  const yOf = (km: number) => PADDING_TOP + innerH - (km / maxKm) * innerH;

  // Solid line through the readings; a closure in between breaks it and adds a
  // dotted bridge instead. Only a genuinely long outage (no closure) leaves a gap.
  const toPaths = (key: 'north' | 'south') => {
    const solid: string[] = [];
    const gap: string[] = [];
    let prev: { x: string; y: string; center: number } | null = null;
    let crossedClosure = false;
    for (const b of buckets) {
      if (b.closed) crossedClosure = true;
      const v = b[key];
      if (v === null) continue;
      const x = xOf(b.center).toFixed(1);
      const y = yOf(v).toFixed(1);
      if (prev && crossedClosure) {
        gap.push(`M${prev.x},${prev.y} L${x},${y}`);
        solid.push(`M${x},${y}`);
      } else {
        const cmd = !prev || b.center - prev.center > MAX_BRIDGE_MS ? 'M' : 'L';
        solid.push(`${cmd}${x},${y}`);
      }
      prev = { x, y, center: b.center };
      crossedClosure = false;
    }
    return { solid: solid.join(' '), gap: gap.join(' ') };
  };
  const northPaths = toPaths('north');
  const southPaths = toPaths('south');

  // ── Time axis ticks — adaptive interval so there are always a few ticks ──
  const ticks: TimeTick[] = [];
  const hours = tSpan / 3_600_000;
  const tickH = hours <= 4 ? 1 : hours <= 12 ? 2 : hours <= 30 ? 6 : 12;
  const tickMs = tickH * 3_600_000;
  const firstTick = Math.ceil(start / tickMs) * tickMs;
  for (let ts = firstTick; ts <= end; ts += tickMs) {
    const d = new Date(ts);
    const h = (d.getUTCHours() + 2) % 24; // approx CEST
    const label = tickH < 6 ? `${String(h).padStart(2, '0')}:00` : `${String(h).padStart(2, '0')}h`;
    ticks.push({ x: +xOf(ts).toFixed(1), label });
  }

  // ── Closure bands: contiguous buckets flagged closed merge into one band ──
  const closures: ClosureBand[] = [];
  buckets.forEach((b, bi) => {
    if (!b.closed) return;
    const left = xOf(b.center - BUCKET_MS / 2);
    const right = xOf(b.center + BUCKET_MS / 2);
    const prev = closures[closures.length - 1];
    if (prev && left - prev.x2 <= 0.5) {
      prev.x2 = +right.toFixed(1);
    } else {
      closures.push({ x1: +left.toFixed(1), x2: +right.toFixed(1) });
    }
  });

  // Hover snaps to bucket centres so the dot always sits on the drawn line.
  const points: ChartPoint[] = buckets
    .filter((b) => b.north !== null || b.south !== null)
    .map((b) => ({
      x: +xOf(b.center).toFixed(1),
      yNorth: +yOf(b.north ?? 0).toFixed(1),
      ySouth: +yOf(b.south ?? 0).toFixed(1),
      t: new Date(b.center).toISOString(),
      north: b.north,
      south: b.south,
    }));

  return {
    northPath: northPaths.solid,
    southPath: southPaths.solid,
    northGapPath: northPaths.gap,
    southGapPath: southPaths.gap,
    width,
    height,
    maxKm,
    ticks,
    yTicks: [0, maxKm / 2, maxKm].map((km) => ({ y: +yOf(km).toFixed(1), km })),
    points,
    closures,
  };
}
