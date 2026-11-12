import { t, type Lang } from './i18n';
import type { GotthardData, RoadStatus, ClosureWindow } from './types';
import { FLAT_THRESHOLD_KM, type TrendDirection } from './trend';
import { fmtDateTime, fmtDayMonth, fmtTime, swissIsoDate } from './swiss-time';

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

/** A single crawlable, natural-language summary sentence describing current conditions. */
export function buildSummary(data: GotthardData, lang: Lang): string {
  const north = data.tunnel.north;
  const south = data.tunnel.south;
  const noNorthQueue = !north.queueKm || north.queueKm <= 0;
  const noSouthQueue = !south.queueKm || south.queueKm <= 0;

  if (data.tunnel.status === 'closed') {
    const reason = closureCauseLabel(data.tunnel.closureReason, lang);
    if (lang === 'de') {
      const lead = `Gotthard-Strassentunnel gesperrt${reason ? ` (${reason})` : ''}.`;
      return `${lead} Gotthardpass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
    }
    const lead = `Gotthard road tunnel closed${reason ? ` (${reason})` : ''}.`;
    return `${lead} Gotthard Pass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
  }

  if (lang === 'de') {
    if (noNorthQueue && noSouthQueue) {
      return `Aktuell freie Fahrt am Gotthard-Strassentunnel in beide Richtungen. Gotthardpass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
    }
    const parts: string[] = [];
    if (!noNorthQueue) parts.push(`${formatKm(north.queueKm, lang)} Rückstau am Nordportal (Göschenen)${waitClause(north.waitMinutes, lang)}`);
    if (!noSouthQueue) parts.push(`${formatKm(south.queueKm, lang)} Rückstau am Südportal (Airolo)${waitClause(south.waitMinutes, lang)}`);
    return `Aktuell: ${parts.join('; ')}. Gotthardpass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
  }

  if (noNorthQueue && noSouthQueue) {
    return `Currently clear at the Gotthard road tunnel in both directions. Gotthard Pass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
  }
  const parts: string[] = [];
  if (!noNorthQueue) parts.push(`${formatKm(north.queueKm, lang)} queue at the north portal (Göschenen)${waitClause(north.waitMinutes, lang)}`);
  if (!noSouthQueue) parts.push(`${formatKm(south.queueKm, lang)} queue at the south portal (Airolo)${waitClause(south.waitMinutes, lang)}`);
  return `Right now: ${parts.join('; ')}. Gotthard Pass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
}
