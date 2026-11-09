import type { HistoryPoint } from './types';

export interface TimeTick {
  x: number;
  label: string;
}

/** A horizontal gridline on the km axis. */
export interface ValueTick {
  y: number;
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
  width: number;
  height: number;
  maxKm: number;
  ticks: TimeTick[];
  yTicks: ValueTick[];
  plotLeft: number;   // x where the plot area starts (right of the km labels)
  plotBottom: number; // y of the zero line
  points: ChartPoint[];
  closures: ClosureBand[];
}

const PADDING_LEFT = 48; // space for the km labels ("2.5 km")
const PADDING_RIGHT = 8;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 24; // space for time labels

// The km axis never shrinks below this, so a 1–2 km queue reads as the small
// queue it is instead of filling the whole chart height.
const MIN_SCALE_KM = 5;
const NICE_STEPS_KM = [5, 10, 15, 20, 30, 40, 60];
const niceMaxKm = (km: number) => NICE_STEPS_KM.find((s) => s >= km) ?? Math.ceil(km / 20) * 20;

// Axis labels are Swiss local time (CET/CEST), whatever the viewer's timezone.
const zurichHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hourCycle: 'h23' });
const localHourOf = (ms: number) => +zurichHour.format(new Date(ms));

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

export function buildSparkline(history: HistoryPoint[], width = 640, height = 220): SparklineResult {
  const empty: SparklineResult = {
    northPath: '', southPath: '', width, height, maxKm: 0, ticks: [], yTicks: [], points: [], closures: [],
    plotLeft: PADDING_LEFT, plotBottom: height - PADDING_BOTTOM,
  };
  if (history.length === 0) return empty;

  // Fixed trailing window ending at the newest reading (not wall-clock "now", so
  // the chart still fills even if the feed briefly stops updating).
  const times = history.map((p) => Date.parse(p.t));
  const end = Math.max(...times);
  const start = end - WINDOW_MS;
  const tSpan = WINDOW_MS;

  const innerW = width - PADDING_LEFT - PADDING_RIGHT;
  const innerH = height - PADDING_TOP - PADDING_BOTTOM;
  const xOf = (t: number) => PADDING_LEFT + (innerW * (t - start)) / tSpan;

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
    if (p.status === 'closed') b.closed = true;
    // The feed reports no queue as null. On an open tunnel that is a real
    // reading of 0 km. Skipping it made the line start out of nowhere at the
    // first queue instead of rising from the zero line. While closed, the
    // queue is genuinely unknown, so those readings stay out of the average.
    const km = (v: number | null | undefined) => (v ?? (p.status === 'closed' ? null : 0));
    const n = km(p.northQueueKm);
    const s = km(p.southQueueKm);
    if (n !== null) { b.nSum += n; b.nCount++; }
    if (s !== null) { b.sSum += s; b.sCount++; }
  });

  const buckets: Bucket[] = acc.map((b, bi) => ({
    center: start + (bi + 0.5) * BUCKET_MS,
    north: b.nCount ? b.nSum / b.nCount : null,
    south: b.sCount ? b.sSum / b.sCount : null,
    closed: b.closed,
  }));

  const maxKm = niceMaxKm(Math.max(
    MIN_SCALE_KM,
    ...buckets.map((b) => Math.max(b.north ?? 0, b.south ?? 0)),
  ));
  const yOf = (km: number) => PADDING_TOP + innerH - (km / maxKm) * innerH;

  const toPath = (key: 'north' | 'south') => {
    const seg: string[] = [];
    let prevCenter = -Infinity;
    for (const b of buckets) {
      const v = b[key];
      if (v === null) continue;
      const cmd = b.center - prevCenter > MAX_BRIDGE_MS ? 'M' : 'L';
      seg.push(`${cmd}${xOf(b.center).toFixed(1)},${yOf(v).toFixed(1)}`);
      prevCenter = b.center;
    }
    return seg.join(' ');
  };

  // ── Time axis ticks — adaptive interval so there are always a few ticks ──
  // Placed on full Swiss-local hours (the old fixed +2 h was an hour off in winter).
  const ticks: TimeTick[] = [];
  const hours = tSpan / 3_600_000;
  const tickH = hours <= 4 ? 1 : hours <= 12 ? 2 : hours <= 30 ? 6 : 12;
  for (let ts = Math.ceil(start / 3_600_000) * 3_600_000; ts <= end; ts += 3_600_000) {
    const h = localHourOf(ts);
    if (h % tickH !== 0) continue;
    const label = tickH < 6 ? `${String(h).padStart(2, '0')}:00` : `${String(h).padStart(2, '0')}h`;
    ticks.push({ x: +xOf(ts).toFixed(1), label });
  }

  // ── Km axis: zero line, middle and top ──
  const yTicks: ValueTick[] = [0, maxKm / 2, maxKm].map((km) => ({
    y: +yOf(km).toFixed(1),
    label: `${Number.isInteger(km) ? km : km.toFixed(1)} km`,
  }));

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
    northPath: toPath('north'),
    southPath: toPath('south'),
    width,
    height,
    maxKm,
    ticks,
    yTicks,
    plotLeft: PADDING_LEFT,
    plotBottom: PADDING_TOP + innerH,
    points,
    closures,
  };
}

/**
 * SVG markup for both axes (km gridlines + labels, hour gridlines + labels).
 * Shared by the server render and the 60-second client refresh, so the scale
 * and the time labels stay in step with the redrawn line.
 */
export function axesSvg(chart: SparklineResult): string {
  const right = chart.width - PADDING_RIGHT;
  const muted = 'var(--color-text-muted)';
  const font = 'font-size="11" font-family="var(--font-sans)"';
  const yAxis = chart.yTicks
    .map((tk) =>
      `<line x1="${chart.plotLeft}" y1="${tk.y}" x2="${right}" y2="${tk.y}" stroke="var(--color-border)" stroke-width="1"${tk.y < chart.plotBottom ? ' stroke-dasharray="4 3"' : ''} />` +
      `<text x="${chart.plotLeft - 4}" y="${tk.y + 4}" text-anchor="end" ${font} fill="${muted}">${tk.label}</text>`,
    )
    .join('');
  const xAxis = chart.ticks
    .map((tk) =>
      `<line x1="${tk.x}" y1="${PADDING_TOP}" x2="${tk.x}" y2="${chart.plotBottom}" stroke="var(--color-border)" stroke-width="1" stroke-dasharray="4 3" />` +
      `<text x="${tk.x}" y="${chart.height - 6}" text-anchor="middle" ${font} fill="${muted}">${tk.label}</text>`,
    )
    .join('');
  return yAxis + xAxis;
}
