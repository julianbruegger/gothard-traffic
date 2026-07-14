import { t, type Lang } from './i18n';
import type { GotthardData, RoadStatus } from './types';

export function formatKm(km: number | null, lang: Lang): string {
  if (km === null || km === undefined) return '–';
  if (km <= 0) return t(lang, 'portal.noQueue');
  return `${km.toLocaleString(lang === 'de' ? 'de-CH' : 'en-CH', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
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
