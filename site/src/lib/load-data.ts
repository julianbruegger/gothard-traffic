import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { computeQueueTrend } from './trend';
import placeholderData from '../data/sample-gotthard.json';
import placeholderHistory from '../data/sample-history.json';
import type { GotthardData, HistoryPoint } from './types';

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {}
  return fallback;
}

/**
 * Data for the home pages (`/` and `/en`).
 *
 * Production build: a NEUTRAL placeholder (status 'unknown', no timestamp, no
 * causes/notes, empty history). Nothing time-sensitive is baked into the static
 * HTML; the live values are injected per request by server/index.php (SSR) and
 * then kept fresh by live.ts. Baking public/data/*.json here used to freeze a
 * months-old snapshot that crawlers and no-JS visitors saw as "current".
 *
 * `astro dev` only: read the sample snapshot in public/data so the UI has
 * something realistic to show without PHP.
 */
export function loadHomeData() {
  let data = placeholderData as GotthardData;
  let history = placeholderHistory as HistoryPoint[];
  if (import.meta.env.DEV) {
    const root = join(process.cwd(), 'public/data');
    data = readJson<GotthardData>(join(root, 'gotthard.json'), data);
    history = readJson<HistoryPoint[]>(join(root, 'history.json'), history);
  }
  const northTrend = computeQueueTrend(history, 'northQueueKm');
  const southTrend = computeQueueTrend(history, 'southQueueKm');
  return { data, history, northTrend, southTrend };
}
