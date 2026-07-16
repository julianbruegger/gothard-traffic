import type { HistoryPoint } from './types';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface QueueTrend {
  direction: TrendDirection;
  deltaKm: number;
}

const FLAT_THRESHOLD_KM = 0.05;

/** Compares the two most recent history points to show whether a queue is growing or shrinking. */
export function computeQueueTrend(
  history: HistoryPoint[],
  key: 'northQueueKm' | 'southQueueKm'
): QueueTrend | null {
  if (history.length < 2) return null;
  const cur = history[history.length - 1][key];
  const prev = history[history.length - 2][key];
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;

  const deltaKm = cur - prev;
  const direction: TrendDirection =
    deltaKm > FLAT_THRESHOLD_KM ? 'up' : deltaKm < -FLAT_THRESHOLD_KM ? 'down' : 'flat';
  return { direction, deltaKm };
}
