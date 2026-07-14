import type { HistoryPoint } from './types';

export interface TimeTick {
  x: number;
  label: string;
}

export interface SparklineResult {
  northPath: string;
  southPath: string;
  width: number;
  height: number;
  maxKm: number;
  ticks: TimeTick[];
}

const PADDING_X = 8;
const PADDING_TOP = 8;
const PADDING_BOTTOM = 24; // space for time labels

export function buildSparkline(history: HistoryPoint[], width = 640, height = 220): SparklineResult {
  if (history.length === 0) {
    return { northPath: '', southPath: '', width, height, maxKm: 0, ticks: [] };
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

  return {
    northPath: toPath('northQueueKm'),
    southPath: toPath('southQueueKm'),
    width,
    height,
    maxKm,
    ticks,
  };
}
