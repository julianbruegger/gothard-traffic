// Single source of truth for page URLs per language.
//
// German lives at the root, English under /en, and the slugs are translated
// (/sperrungen ↔ /en/closures), so "the same page in another language" can't be
// derived by adding or stripping a prefix. Layout (canonical + hreflang),
// Header (language switch), Footer/guide links and the sitemap (astro.config.mjs)
// all look pages up here.
//
// Adding a language later: add it to `Lang`/`LANGS` in i18n.ts, add its
// `HREFLANG` tag below and a path for every page that exists in that language.
// A page without a path for a language simply has no alternate in it (the
// language switch then falls back to that language's home page).
//
// Keep this file free of runtime imports: astro.config.mjs imports it too.

import type { Lang } from './i18n';

export type RouteKey =
  | 'home'
  | 'forecasts'
  | 'statistics'
  | 'nerd'
  | 'christmas'
  | 'easter'
  | 'closures'
  | 'pass'
  | 'alternatives'
  | 'data';

export const ROUTES: Record<RouteKey, Partial<Record<Lang, string>>> = {
  home: { de: '/', en: '/en' },
  forecasts: { de: '/forecasts', en: '/en/forecasts' },
  statistics: { de: '/statistics', en: '/en/statistics' },
  nerd: { de: '/nerd', en: '/en/nerd' },
  christmas: { de: '/weihnachten-neujahr', en: '/en/christmas-new-year' },
  easter: { de: '/ostern', en: '/en/easter' },
  closures: { de: '/sperrungen', en: '/en/closures' },
  pass: { de: '/gotthardpass', en: '/en/gotthard-pass' },
  alternatives: { de: '/alternativen', en: '/en/alternative-routes' },
  data: { de: '/daten', en: '/en/data' },
};

/** Language tag used in hreflang (HTML and sitemap). */
export const HREFLANG: Record<Lang, string> = { de: 'de', en: 'en' };

/** The language whose URL is announced as x-default. */
export const X_DEFAULT_LANG: Lang = 'de';

/** Topic landing pages ("Gotthard guides"), in the order they are linked. */
export const GUIDES = ['christmas', 'closures', 'pass', 'alternatives'] as const satisfies readonly RouteKey[];
export type GuideKey = (typeof GUIDES)[number];

/** "/sperrungen.html", "/en/", "/en/index.html" → "/sperrungen", "/en". */
export function normalizePath(pathname: string): string {
  const p = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
  return p !== '/' ? p.replace(/\/+$/, '') || '/' : '/';
}

/** Route key and language of a URL path, or null for an unknown page. */
export function lookupPath(pathname: string): { key: RouteKey; lang: Lang } | null {
  const path = normalizePath(pathname);
  for (const key of Object.keys(ROUTES) as RouteKey[]) {
    for (const [lang, p] of Object.entries(ROUTES[key]) as [Lang, string][]) {
      if (p === path) return { key, lang };
    }
  }
  return null;
}

/** Path of a page in a language; falls back to that language's home. */
export function routePath(key: RouteKey, lang: Lang): string {
  return ROUTES[key][lang] ?? ROUTES.home[lang] ?? '/';
}

/** All language versions of a page as [lang, path] pairs (only languages that have it). */
export function alternates(key: RouteKey): [Lang, string][] {
  return Object.entries(ROUTES[key]) as [Lang, string][];
}
