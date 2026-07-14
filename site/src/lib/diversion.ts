import type { Lang } from './i18n';
import type { GotthardData } from './types';

// Wait (minutes) at or above which we start suggesting alternative routes.
export const DIVERSION_THRESHOLD_MIN = 20;

export interface DiversionRoute {
  id: string;
  name: string;
  description: string;
  extraMinutes: number;   // typical extra travel time vs. a free-flowing tunnel
  available: boolean;
  recommended: boolean;   // available and faster than sitting in the current queue
  note: string | null;
}

export interface DiversionResult {
  trigger: boolean;
  worstWait: number;
  directionLabel: string | null;
  routes: DiversionRoute[];
}

type Bi = { de: string; en: string };
const L = (lang: Lang, s: Bi) => s[lang];

interface RouteDef {
  id: string;
  name: Bi;
  description: Bi;
  extraMinutes: number;
  available: (data: GotthardData) => boolean;
  note?: (data: GotthardData) => Bi | null;
}

// Extra minutes are rough typical add-ons versus a free-flowing Gotthard transit.
const ROUTES: RouteDef[] = [
  {
    id: 'san-bernardino',
    name: { de: 'San-Bernardino (A13)', en: 'San Bernardino (A13)' },
    description: {
      de: 'Autobahn A13 via San-Bernardino-Tunnel (Chur – Bellinzona). Ganzjährig offen.',
      en: 'A13 motorway via the San Bernardino tunnel (Chur – Bellinzona). Open year-round.',
    },
    extraMinutes: 45,
    available: () => true,
  },
  {
    id: 'gotthard-pass',
    name: { de: 'Gotthardpass (Passstrasse)', en: 'Gotthard Pass (mountain road)' },
    description: {
      de: 'Über die Passhöhe (Tremola). Landschaftlich, aber langsam – nur bei offener Passstrasse.',
      en: 'Over the summit (Tremola). Scenic but slow — only while the pass road is open.',
    },
    extraMinutes: 60,
    available: (data) => data.pass.status === 'open' || data.pass.status === 'restricted',
    note: (data) =>
      data.pass.status === 'restricted'
        ? { de: 'Nur eingeschränkt befahrbar.', en: 'Restricted access.' }
        : data.pass.status !== 'open'
          ? { de: 'Derzeit geschlossen (Winter).', en: 'Currently closed (winter).' }
          : null,
  },
  {
    id: 'simplon',
    name: { de: 'Simplon / Grosser St. Bernhard', en: 'Simplon / Great St Bernard' },
    description: {
      de: 'Weiträumige Umfahrung über die Westalpen – nur bei sehr langem Rückstau sinnvoll.',
      en: 'Wide detour via the western Alps — only worthwhile during very long queues.',
    },
    extraMinutes: 120,
    available: () => true,
  },
];

/**
 * Decide whether to surface diversion suggestions and rank the alternatives.
 * Triggers when the worst directional wait reaches DIVERSION_THRESHOLD_MIN.
 */
export function suggestDiversions(data: GotthardData, lang: Lang): DiversionResult {
  const northWait = data.tunnel.north.waitMinutes ?? 0;
  const southWait = data.tunnel.south.waitMinutes ?? 0;
  const worstWait = Math.max(northWait, southWait);

  const directionLabel =
    worstWait <= 0
      ? null
      : northWait >= southWait
        ? L(lang, { de: 'Nord → Italien (Göschenen)', en: 'North → Italy (Göschenen)' })
        : L(lang, { de: 'Süd → CH (Airolo)', en: 'South → CH (Airolo)' });

  const routes: DiversionRoute[] = ROUTES.map((r) => {
    const available = r.available(data);
    return {
      id: r.id,
      name: L(lang, r.name),
      description: L(lang, r.description),
      extraMinutes: r.extraMinutes,
      available,
      recommended: available && r.extraMinutes < worstWait,
      note: r.note ? (r.note(data) ? L(lang, r.note(data) as Bi) : null) : null,
    };
  }).sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.available !== b.available) return a.available ? -1 : 1;
    return a.extraMinutes - b.extraMinutes;
  });

  return {
    trigger: worstWait >= DIVERSION_THRESHOLD_MIN,
    worstWait,
    directionLabel,
    routes,
  };
}
