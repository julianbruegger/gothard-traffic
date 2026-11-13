import { t, type Lang } from './i18n';
import type { GotthardData, RoadStatus, ClosureWindow } from './types';
import { FLAT_THRESHOLD_KM, type TrendDirection } from './trend';
import { fmtDateTime, fmtDayMonth, fmtIsoDayMonth, fmtTime, swissIsoDate } from './swiss-time';

// DATEX "Ursache" / causeType values seen on Gotthard closures → friendly label.
const CLOSURE_CAUSE: Record<string, { de: string; en: string }> = {
  ausnahmetransport: { de: 'Sondertransport', en: 'Special transport' },
  sondertransport: { de: 'Sondertransport', en: 'Special transport' },
  bauarbeiten: { de: 'Bauarbeiten', en: 'Roadworks' },
  baustelle: { de: 'Bauarbeiten', en: 'Roadworks' },
  wartung: { de: 'Wartungsarbeiten', en: 'Maintenance' },
  unterhalt: { de: 'Unterhaltsarbeiten', en: 'Maintenance' },
  unterhaltsarbeiten: { de: 'Unterhaltsarbeiten', en: 'Maintenance' },
  pannenfahrzeug: { de: 'Pannenfahrzeug', en: 'Broken-down vehicle' },
  unfall: { de: 'Unfall', en: 'Accident' },
  brand: { de: 'Brand', en: 'Fire' },
};

export function closureCauseLabel(cause: string | null | undefined, lang: Lang): string | null {
  if (!cause) return null;
  const hit = CLOSURE_CAUSE[cause.trim().toLowerCase()];
  return hit ? hit[lang] : cause;
}

/** Same calendar day in Swiss time, regardless of the browser's timezone. */
function sameLocalDay(a: Date, b: Date): boolean {
  return swissIsoDate(a) === swissIsoDate(b);
}

/** Headline for a planned closure: flags a same-day (tonight) closure specially. */
export function closureTitle(c: ClosureWindow, lang: Lang): string {
  const from = new Date(c.from);
  const now = new Date();
  const startsToday = !Number.isNaN(from.getTime()) && sameLocalDay(from, now) && from > now;
  if (lang === 'de') return startsToday ? 'Geplante Sperrung heute Nacht!' : 'Geplante Tunnelsperrung';
  return startsToday ? 'Planned closure tonight!' : 'Planned tunnel closure';
}

/** Detail line in Swiss time: "Sondertransport – 15.07. 23:00 – 16.07. 01:00" / "Special transport – 15 Jul 23:00 – 16 Jul 01:00". */
export function closureDetail(c: ClosureWindow, lang: Lang): string {
  const from = new Date(c.from);
  const to = c.to ? new Date(c.to) : null;
  const day = (d: Date) => fmtDayMonth(d, lang);
  const time = (d: Date) => fmtTime(d, lang);

  let range = '';
  if (!Number.isNaN(from.getTime())) {
    if (to && !Number.isNaN(to.getTime())) {
      range = sameLocalDay(from, to)
        ? `${day(from)}, ${time(from)}–${time(to)}`
        : `${day(from)} ${time(from)} – ${day(to)} ${time(to)}`;
    } else {
      range = `${day(from)} ${time(from)}`;
    }
  }

  const cause = closureCauseLabel(c.cause, lang);
  return cause && range ? `${cause} – ${range}` : cause ?? range;
}

export function formatKm(km: number | null, lang: Lang): string {
  if (km === null || km === undefined) return '–';
  if (km <= 0) return t(lang, 'portal.noQueue');
  return `${km.toLocaleString(lang === 'de' ? 'de-CH' : 'en-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

export const TREND_ARROW: Record<TrendDirection, string> = { up: '↑', down: '↓', flat: '→' };

/** Signed delta label for a queue-length trend badge, e.g. "+1.2 km", "−0.5 km", "±0.0 km". */
export function formatTrendDelta(deltaKm: number, lang: Lang): string {
  const sign = deltaKm > FLAT_THRESHOLD_KM ? '+' : deltaKm < -FLAT_THRESHOLD_KM ? '−' : '±';
  const loc = lang === 'de' ? 'de-CH' : 'en-CH';
  const magnitude = Math.abs(deltaKm).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${sign}${magnitude} km`;
}

export function formatMinutes(min: number | null, lang: Lang): string {
  if (min === null || min === undefined || min <= 0) return '–';
  return `${Math.round(min)} ${t(lang, 'portal.minutes')}`;
}

/**
 * Wait time for a portal. A known, empty queue shows "0 Min" instead of a dash
 * (which reads like missing data); the dash stays for truly unknown values
 * (no queue figure at all, or the data is stale).
 */
export function formatWait(portal: { queueKm: number | null; waitMinutes: number | null }, lang: Lang, stale = false): string {
  if (stale) return '–';
  if (portal.waitMinutes !== null && portal.waitMinutes !== undefined && portal.waitMinutes > 0) {
    return formatMinutes(portal.waitMinutes, lang);
  }
  if (portal.queueKm !== null && portal.queueKm !== undefined && portal.queueKm <= 0) {
    return `0 ${t(lang, 'portal.minutes')}`;
  }
  return '–';
}

// ─── Data freshness ───────────────────────────────────────────────────────────

/** Older than this, a reading is flagged as stale. */
export const STALE_AFTER_MIN = 20;
/** Older than this (or no timestamp at all), live data counts as unavailable. */
export const UNAVAILABLE_AFTER_MIN = 6 * 60;

export type Freshness = 'fresh' | 'stale' | 'unavailable';

/** Age of a reading, judged by its own `updated` timestamp (not by when it was fetched). */
export function dataFreshness(updated: string | null | undefined, now: Date = new Date()): { level: Freshness; ageMin: number | null } {
  const ts = updated ? new Date(updated).getTime() : NaN;
  if (Number.isNaN(ts)) return { level: 'unavailable', ageMin: null };
  const ageMin = Math.max(0, Math.floor((now.getTime() - ts) / 60_000));
  const level: Freshness = ageMin > UNAVAILABLE_AFTER_MIN ? 'unavailable' : ageMin > STALE_AFTER_MIN ? 'stale' : 'fresh';
  return { level, ageMin };
}

/** "25 Min", "2 Std 5 Min" / "25 min", "2 h 5 min". */
export function formatAge(ageMin: number, lang: Lang): string {
  const min = t(lang, 'portal.minutes');
  if (ageMin < 60) return `${ageMin} ${min}`;
  const h = Math.floor(ageMin / 60);
  const m = ageMin % 60;
  const hUnit = lang === 'de' ? 'Std' : 'h';
  return m ? `${h} ${hUnit} ${m} ${min}` : `${h} ${hUnit}`;
}

/** Warning line for the hero banner, or null when the data is fresh. */
export function staleMessage(f: { level: Freshness; ageMin: number | null }, lang: Lang): string | null {
  if (f.level === 'fresh') return null;
  if (f.level === 'unavailable' || f.ageMin === null) return t(lang, 'hero.staleUnavailable');
  return t(lang, 'hero.stale').replace('{age}', formatAge(f.ageMin, lang));
}

export function statusLabel(status: RoadStatus, lang: Lang): string {
  switch (status) {
    case 'open':
      return t(lang, 'status.open');
    case 'congested':
      return t(lang, 'status.congested');
    case 'restricted':
      return t(lang, 'status.restricted');
    case 'closed':
      return t(lang, 'status.closed');
    default:
      return t(lang, 'status.unknown');
  }
}

export function passStatusLabel(status: RoadStatus, lang: Lang): string {
  switch (status) {
    case 'open':
      return t(lang, 'pass.open');
    case 'closed':
      return t(lang, 'pass.closed');
    case 'restricted':
      return t(lang, 'pass.restricted');
    default:
      return t(lang, 'pass.unknown');
  }
}

export function formatUpdated(iso: string | null, lang: Lang): string {
  if (!iso) return '–';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '–';
  return fmtDateTime(date, lang);
}

/** ", ca. 25 Min Wartezeit" - empty when no wait is reported (mirrors Format::waitClause). */
function waitClause(min: number | null, lang: Lang): string {
  if (min === null || min === undefined || min <= 0) return '';
  return lang === 'de' ? `, ca. ${formatMinutes(min, lang)} Wartezeit` : `, about ${formatMinutes(min, lang)} wait`;
}

// ─── Answer-first summary (mirrors Format::summary in server/lib/Format.php) ──

function parseDate(iso: string | null | undefined): Date | null {
  if (!iso || !iso.trim()) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "YYYY-MM-DD" of the following calendar day (pure date arithmetic, no timezone). */
function nextIsoDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** de: "heute", "morgen", "15.07."; en: "today", "tonight" (from 18:00), "tomorrow", "15 Jul". */
function relativeDay(d: Date, now: Date, lang: Lang): string {
  const today = swissIsoDate(now);
  const day = swissIsoDate(d);
  if (day === today) {
    if (lang === 'de') return 'heute';
    return Number(fmtTime(d).slice(0, 2)) >= 18 ? 'tonight' : 'today';
  }
  if (day === nextIsoDay(today)) return lang === 'de' ? 'morgen' : 'tomorrow';
  return fmtIsoDayMonth(day, lang);
}

/** Friendly cause label; mapped English labels are lower-cased to read inside a sentence. */
function inlineCause(cause: string | null | undefined, lang: Lang): string | null {
  const label = closureCauseLabel(cause, lang);
  if (label === null) return null;
  return lang === 'en' && label !== cause ? label.toLowerCase() : label;
}

/** First planned closure that has not ended yet (the list is sorted by start). */
function nextClosure(closures: ClosureWindow[], now: Date): { from: Date; to: Date | null; cause: string | null } | null {
  for (const c of closures) {
    const from = parseDate(c?.from);
    if (!from) continue;
    const to = parseDate(c.to);
    if ((to ?? from).getTime() > now.getTime()) return { from, to, cause: typeof c.cause === 'string' ? c.cause : null };
  }
  return null;
}

/** "heute 23:00–01:00 Uhr (Unterhaltsarbeiten)" / "tonight 23:00–01:00 (maintenance)". */
function closurePhrase(c: { from: Date; to: Date | null; cause: string | null }, now: Date, lang: Lang): string {
  const de = lang === 'de';
  const day = relativeDay(c.from, now, lang);
  const t1 = fmtTime(c.from);
  let text: string;
  if (!c.to) {
    text = de ? `${day} ab ${t1} Uhr` : `${day} from ${t1}`;
  } else if (c.to.getTime() - c.from.getTime() < 86_400_000) {
    const t2 = fmtTime(c.to);
    text = de ? `${day} ${t1}–${t2} Uhr` : `${day} ${t1}–${t2}`;
  } else {
    const day2 = relativeDay(c.to, now, lang);
    const t2 = fmtTime(c.to);
    text = de ? `${day} ${t1} Uhr bis ${day2} ${t2} Uhr` : `${day} ${t1} to ${day2} ${t2}`;
  }
  const cause = inlineCause(c.cause, lang);
  return cause !== null ? `${text} (${cause})` : text;
}

/**
 * Answer-first summary: one to three self-contained, quotable sentences with the
 * Swiss-time timestamp, queue figures, pass status and the next planned closure.
 * Crawlers, snippets, AI assistants and api/summary.php quote it (the PHP twin
 * must produce identical strings: `node scripts/test-summary-parity.mjs`).
 * `now` only decides "today/tomorrow" and which planned closures are over.
 */
export function buildSummary(data: GotthardData, lang: Lang, now: Date = new Date()): string {
  const de = lang === 'de';
  const tunnel = data.tunnel;
  const north = tunnel.north;
  const south = tunnel.south;
  const noNorthQueue = !north.queueKm || north.queueKm <= 0;
  const noSouthQueue = !south.queueKm || south.queueKm <= 0;

  const stamp = parseDate(data.updated) ? formatUpdated(data.updated, lang) : null;
  const head = de
    ? `Gotthard-Strassentunnel${stamp !== null ? `, ${stamp} Uhr` : ''}: `
    : `Gotthard road tunnel${stamp !== null ? `, ${stamp}` : ''}: `;

  let body: string;
  if (tunnel.status === 'closed') {
    const reason = inlineCause(tunnel.closureReason, lang);
    body = `${de ? 'gesperrt' : 'closed'}${reason !== null ? ` (${reason})` : ''}`;
  } else if (tunnel.status === 'unknown' && north.queueKm == null && south.queueKm == null) {
    body = de ? 'Verkehrslage unbekannt' : 'traffic situation unknown';
  } else if (noNorthQueue && noSouthQueue) {
    body = de ? 'kein Stau in beiden Richtungen' : 'no queue in either direction';
  } else {
    const parts: string[] = [];
    if (!noNorthQueue) {
      parts.push(`${formatKm(north.queueKm, lang)}${de ? ' Rückstau am Nordportal (Göschenen)' : ' queue at the north portal (Göschenen)'}${waitClause(north.waitMinutes, lang)}`);
    }
    if (!noSouthQueue) {
      parts.push(`${formatKm(south.queueKm, lang)}${de ? ' Rückstau am Südportal (Airolo)' : ' queue at the south portal (Airolo)'}${waitClause(south.waitMinutes, lang)}`);
    }
    body = parts.join('; ');
  }

  const pass = passStatusLabel(data.pass?.status ?? 'unknown', lang);
  let out = `${head}${body}. ${de ? `Gotthardpass: ${pass}.` : `Gotthard Pass: ${pass.toLowerCase()}.`}`;

  const next = nextClosure(Array.isArray(tunnel.plannedClosures) ? tunnel.plannedClosures : [], now);
  if (next) out += `${de ? ' Nächste geplante Sperrung: ' : ' Next planned closure: '}${closurePhrase(next, now, lang)}.`;
  return out;
}
