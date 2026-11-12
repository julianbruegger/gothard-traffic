// Runtime copy of the measured per-day data.
//
// The bundled observed-days.json is only a snapshot from build time. In the
// browser we additionally fetch api/observed.php (built from the database,
// cached server side for 1 h) and refit the forecast model on it, so the model
// always includes yesterday. If the endpoint is missing (local dev) or fails,
// the bundled copy stays in use.
//
// Importing this module is enough: it starts the load once, in the browser only.

import { observedDays as bundledDays, type ObservedDay } from './observed-model';
import { setObservedDays } from './forecast';

let current: ObservedDay[] = bundledDays;

/** Fired on `window` after the runtime data replaced the bundled copy. */
export const OBSERVED_UPDATED_EVENT = 'observed-days-updated';

/** Latest measured days: the runtime copy once loaded, else the bundled one. */
export function currentObservedDays(): ObservedDay[] {
  return current;
}

function isDay(x: unknown): x is ObservedDay {
  const d = x as ObservedDay;
  return !!d && typeof d.d === 'string' && Array.isArray(d.n) && Array.isArray(d.s) && d.n.length === 24 && d.s.length === 24;
}

async function loadRuntimeDays(): Promise<void> {
  try {
    const res = await fetch('/api/observed.php', { cache: 'no-cache' });
    if (!res.ok) return;
    const json = (await res.json()) as { days?: unknown };
    const days = Array.isArray(json.days) ? json.days.filter(isDay) : [];
    if (days.length < 14) return;
    current = days;
    setObservedDays(days);
    window.dispatchEvent(new Event(OBSERVED_UPDATED_EVENT));
  } catch {
    // Offline or no PHP backend: keep the bundled data.
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  void loadRuntimeDays();
}
