import type { HistoryPoint } from './types';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface QueueTrend {
  direction: TrendDirection;
  deltaKm: number;
}

export const FLAT_THRESHOLD_KM = 0.05;

/** Window over which the queue trend is measured. */
export const TREND_WINDOW_MS = 30 * 60_000;

/**
 * Compares the newest sample with the oldest one inside the last ~30 minutes
 * (needs at least two samples in that window). Returns null when there is no
 * queue at either end, so an empty portal doesn't show a meaningless "±0.0 km".
 */
export function computeQueueTrend(
  history: HistoryPoint[],
  key: 'northQueueKm' | 'southQueueKm'
): QueueTrend | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const cur = last[key];
  const lastTs = new Date(last.t).getTime();
  if (cur === null || cur === undefined || Number.isNaN(lastTs)) return null;

  let prev: number | null = null;
  for (let i = history.length - 2; i >= 0; i--) {
    const ts = new Date(history[i].t).getTime();
    if (Number.isNaN(ts) || lastTs - ts > TREND_WINDOW_MS) break;
    const v = history[i][key];
    if (v === null || v === undefined) continue;
    prev = v; // keeps overwriting: ends on the oldest sample inside the window
  }
  if (prev === null) return null;
  if (cur <= 0 && prev <= 0) return null;

  const deltaKm = cur - prev;
  const direction: TrendDirection =
    deltaKm > FLAT_THRESHOLD_KM ? 'up' : deltaKm < -FLAT_THRESHOLD_KM ? 'down' : 'flat';
  return { direction, deltaKm };
}
