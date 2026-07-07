import type { HistoryPoint } from './types';

export interface SparklineResult {
  northPath: string;
  southPath: string;
  width: number;
  height: number;
  maxKm: number;
}

const PADDING = 8;

export function buildSparkline(history: HistoryPoint[], width = 640, height = 200): SparklineResult {
  if (history.length === 0) {
    return { northPath: '', southPath: '', width, height, maxKm: 0 };
  }
  const maxKm = Math.max(1, ...history.map((p) => Math.max(p.northQueueKm ?? 0, p.southQueueKm ?? 0)));
  const innerW = width - PADDING * 2;
  const innerH = height - PADDING * 2;
  const step = history.length > 1 ? innerW / (history.length - 1) : 0;

  const toPath = (key: 'northQueueKm' | 'southQueueKm') =>
    history
      .map((p, i) => {
        const value = p[key] ?? 0;
        const x = PADDING + step * i;
        const y = PADDING + innerH - (value / maxKm) * innerH;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  return {
    northPath: toPath('northQueueKm'),
    southPath: toPath('southQueueKm'),
    width,
    height,
    maxKm,
  };
}
