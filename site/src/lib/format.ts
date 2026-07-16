import { t, type Lang } from './i18n';
import type { GotthardData, RoadStatus, ClosureWindow } from './types';
import type { TrendDirection } from './trend';

// DATEX "Ursache" / causeType values seen on Gotthard closures → friendly label.
const CLOSURE_CAUSE: Record<string, { de: string; en: string }> = {
  ausnahmetransport: { de: 'Sondertransport', en: 'Special transport' },
  sondertransport: { de: 'Sondertransport', en: 'Special transport' },
  bauarbeiten: { de: 'Bauarbeiten', en: 'Roadworks' },
  baustelle: { de: 'Bauarbeiten', en: 'Roadworks' },
  wartung: { de: 'Wartungsarbeiten', en: 'Maintenance' },
  unterhalt: { de: 'Unterhaltsarbeiten', en: 'Maintenance' },
  unterhaltsarbeiten: { de: 'Unterhaltsarbeiten', en: 'Maintenance' },
};

function closureCauseLabel(cause: string | null, lang: Lang): string | null {
  if (!cause) return null;
  const hit = CLOSURE_CAUSE[cause.trim().toLowerCase()];
  return hit ? hit[lang] : cause;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Headline for a planned closure: flags a same-day (tonight) closure specially. */
export function closureTitle(c: ClosureWindow, lang: Lang): string {
  const from = new Date(c.from);
  const startsToday = !Number.isNaN(from.getTime()) && sameLocalDay(from, new Date()) && from > new Date();
  if (lang === 'de') return startsToday ? 'Geplante Sperrung heute Nacht!' : 'Geplante Tunnelsperrung';
  return startsToday ? 'Planned closure tonight!' : 'Planned tunnel closure';
}

/** Detail line: "Sondertransport – 15.07. 23:00 – 16.07. 01:00". */
export function closureDetail(c: ClosureWindow, lang: Lang): string {
  const loc = lang === 'de' ? 'de-CH' : 'en-CH';
  const from = new Date(c.from);
  const to = c.to ? new Date(c.to) : null;
  const day = (d: Date) => new Intl.DateTimeFormat(loc, { day: '2-digit', month: '2-digit' }).format(d);
  const time = (d: Date) => new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit' }).format(d);

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
  const sign = deltaKm > 0.05 ? '+' : deltaKm < -0.05 ? '−' : '±';
  const loc = lang === 'de' ? 'de-CH' : 'en-CH';
  const magnitude = Math.abs(deltaKm).toLocaleString(loc, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${sign}${magnitude} km`;
}

export function formatMinutes(min: number | null, lang: Lang): string {
  if (min === null || min === undefined || min <= 0) return '–';
  return `${Math.round(min)} ${t(lang, 'portal.minutes')}`;
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
  return new Intl.DateTimeFormat(lang === 'de' ? 'de-CH' : 'en-CH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

/** A single crawlable, natural-language summary sentence describing current conditions. */
export function buildSummary(data: GotthardData, lang: Lang): string {
  const north = data.tunnel.north;
  const south = data.tunnel.south;
  const noNorthQueue = !north.queueKm || north.queueKm <= 0;
  const noSouthQueue = !south.queueKm || south.queueKm <= 0;

  if (lang === 'de') {
    if (noNorthQueue && noSouthQueue) {
      return `Aktuell freie Fahrt am Gotthard-Strassentunnel in beide Richtungen. Gotthardpass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
    }
    const parts: string[] = [];
    if (!noNorthQueue) parts.push(`${formatKm(north.queueKm, lang)} Rückstau am Nordportal (Göschenen), ca. ${formatMinutes(north.waitMinutes, lang)} Wartezeit`);
    if (!noSouthQueue) parts.push(`${formatKm(south.queueKm, lang)} Rückstau am Südportal (Airolo), ca. ${formatMinutes(south.waitMinutes, lang)} Wartezeit`);
    return `Aktuell: ${parts.join('; ')}. Gotthardpass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
  }

  if (noNorthQueue && noSouthQueue) {
    return `Currently clear at the Gotthard road tunnel in both directions. Gotthard Pass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
  }
  const parts: string[] = [];
  if (!noNorthQueue) parts.push(`${formatKm(north.queueKm, lang)} queue at the north portal (Göschenen), about ${formatMinutes(north.waitMinutes, lang)} wait`);
  if (!noSouthQueue) parts.push(`${formatKm(south.queueKm, lang)} queue at the south portal (Airolo), about ${formatMinutes(south.waitMinutes, lang)} wait`);
  return `Right now: ${parts.join('; ')}. Gotthard Pass: ${passStatusLabel(data.pass.status, lang).toLowerCase()}.`;
}
