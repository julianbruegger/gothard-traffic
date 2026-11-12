// Single home for date/time formatting. Everything is pinned to Europe/Zurich so
// a visitor's browser timezone never changes the clock times we print.
// Day/month style: German "11.11.", English "11 Nov" (no ambiguous mm/dd).
import type { Lang } from './i18n';

export const SWISS_TZ = 'Europe/Zurich';

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const cache = new Map<string, Intl.DateTimeFormat>();
function formatter(key: string, locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: SWISS_TZ });
    cache.set(key, f);
  }
  return f;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** "10:27" (24 h, Swiss time). */
export function fmtTime(d: Date, _lang: Lang = 'de'): string {
  return formatter('time', 'en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}

/** Swiss calendar date as "YYYY-MM-DD", for same-day comparisons. */
export function swissIsoDate(d: Date): string {
  return formatter('iso', 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Day/month label from an ISO "YYYY-MM-DD" string (pure string work, no timezone involved). */
export function fmtIsoDayMonth(iso: string, lang: Lang): string {
  const [, m, d] = iso.split('-');
  if (!m || !d) return iso;
  return lang === 'de' ? `${pad2(Number(d))}.${pad2(Number(m))}.` : `${Number(d)} ${MONTHS_EN[Number(m) - 1]}`;
}

/** "11.11." / "11 Nov". */
export function fmtDayMonth(d: Date, lang: Lang): string {
  return fmtIsoDayMonth(swissIsoDate(d), lang);
}

/** "11.11.2026, 10:27" / "11 Nov 2026, 10:27". */
export function fmtDateTime(d: Date, lang: Lang): string {
  const [y, m, day] = swissIsoDate(d).split('-');
  const date = lang === 'de' ? `${day}.${m}.${y}` : `${Number(day)} ${MONTHS_EN[Number(m) - 1]} ${y}`;
  return `${date}, ${fmtTime(d)}`;
}

/** "Mi, 11.11." / "Wed, 11 Nov" (weekday + day/month, Swiss calendar day). */
export function fmtWeekdayDate(d: Date, lang: Lang): string {
  const wd = formatter(`wd-${lang}`, lang === 'de' ? 'de-CH' : 'en-GB', { weekday: 'short' }).format(d).replace(/\.$/, '');
  return `${wd}, ${fmtDayMonth(d, lang)}`;
}
