import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import sampleData from '../data/sample-gotthard.json';
import sampleHistory from '../data/sample-history.json';
import type { GotthardData, HistoryPoint } from './types';

function readJson<T>(path: string, fallback: T): T {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {}
  return fallback;
}

/**
 * Reads the live snapshot + history written into public/data at build time,
 * falling back to the bundled samples. Shared by the German (`/`) and English
 * (`/en`) home pages so both render identical data without duplicating the
 * file-reading logic.
 */
export function loadHomeData() {
  const root = join(process.cwd(), 'public/data');
  const data = readJson<GotthardData>(join(root, 'gotthard.json'), sampleData as GotthardData);
  const history = readJson<HistoryPoint[]>(join(root, 'history.json'), sampleHistory as HistoryPoint[]);
  return { data, history };
}
