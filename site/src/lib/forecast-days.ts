// Per-day forecast summaries (expected peak wait per direction) and their
// crawler-readable HTML rendering.
//
// The same summaries feed three places:
//   * pages/forecast-days.json.ts emits them for the next FORECAST_DAYS days at
//     build time (dist/forecast-days.json). The PHP host has no Node, so
//     server/lib/ForecastTable.php reads that file and renders the table for the
//     current Swiss day on every request (the <!--SSR:forecast-week--> marker).
//   * WeekOutlook.astro / ForecastsContent.astro render forecastWeekHtml() for
//     the build day as the static fallback inside that marker.
//   * live.ts draws the home page week bars from forecastDaySummary().
//
// IMPORTANT: forecastWeekHtml / forecastRangeHtml must produce byte-identical
// markup to ForecastTable.php (same strings, same escaping) so the static
// fallback and the server render never drift apart. Change both together.
//
// Direction convention (same as forecast.ts and the i18n keys):
//   north = queue at the north portal Göschenen = traffic heading SOUTH ("dir.south")
//   south = queue at the south portal Airolo   = traffic heading NORTH ("dir.north")

import { generateDayCurve, swissDayInfo, type DayCurve } from './forecast';
import { t, type Lang } from './i18n';

/** Days covered by forecast-days.json (long enough to reach the next Easter from November). */
export const FORECAST_DAYS = 180;
/** Expected peak below this (minutes) counts as "no relevant queue" (same as the forecasts page). */
export const QUIET_PEAK_MIN = 5;
/** Days in the week table: today plus the next 7. */
export const WEEK_TABLE_DAYS = 8;
/** Longest range a forecast-range marker renders. */
export const MAX_RANGE_DAYS = 62;

export interface ForecastDirPeak {
  peakMin: number;          // expected peak wait (minutes), typical day
  peakHour: number | null;  // Swiss-local hour of that peak (rounded), null when there is no queue
  peakKm: number;           // expected peak queue (km), typical day
  busyMin: number;          // upper edge of the forecast range ("busy day") at its own peak (minutes)
}

export interface ForecastDayRow {
  date: string; // Swiss-local "YYYY-MM-DD"
  north: ForecastDirPeak;
  south: ForecastDirPeak;
  holiday: { de: string; en: string } | null;
}

function dirPeak(curve: DayCurve, dir: 'north' | 'south'): ForecastDirPeak {
  const wait = dir === 'north' ? 'northWait' : 'southWait';
  const high = dir === 'north' ? 'northWaitHigh' : 'southWaitHigh';
  const idx = dir === 'north' ? 'northIdx' : 'southIdx';
  let peak = curve.points[0];
  for (const p of curve.points) if (p[wait] > peak[wait]) peak = p;
  const peakMin = peak[wait];
  return {
    peakMin,
    peakHour: peakMin > 0 ? Math.round(peak.minuteOfDay / 60) % 24 : null,
    peakKm: Math.round(Math.max(...curve.points.map((p) => p[idx])) * 10) / 10,
    busyMin: Math.max(...curve.points.map((p) => p[high])),
  };
}

/** Forecast summary for the Swiss-local day containing `day`. */
export function forecastDaySummary(day: Date): ForecastDayRow {
  const de = generateDayCurve(day, 'de');
  const en = generateDayCurve(day, 'en');
  return {
    date: de.isoDate,
    north: dirPeak(de, 'north'),
    south: dirPeak(de, 'south'),
    holiday: de.context && en.context ? { de: de.context, en: en.context } : null,
  };
}

/** Summaries for `count` consecutive Swiss-local days starting with the day containing `from`. */
export function forecastDaySummaries(from: Date, count: number): ForecastDayRow[] {
  const [y, m, d] = swissDayInfo(from).isoDate.split('-').map(Number);
  // Noon UTC is always on the same Swiss calendar day, whatever the DST offset.
  return Array.from({ length: count }, (_, i) => forecastDaySummary(new Date(Date.UTC(y, m - 1, d + i, 12))));
}

// ─── HTML (mirrors server/lib/ForecastTable.php) ─────────────────────────────

const DOW = { de: ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] } as const;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const pad2 = (n: number) => String(n).padStart(2, '0');

function dayLabel(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return lang === 'de' ? `${DOW.de[dow]} ${pad2(d)}.${pad2(m)}.` : `${DOW.en[dow]} ${d} ${MONTHS_EN[m - 1]}`;
}

const hourLabel = (h: number, lang: Lang) => (lang === 'de' ? `${h} Uhr` : `${pad2(h)}:00`);
const quiet = (p: ForecastDirPeak) => p.peakMin < QUIET_PEAK_MIN;
const dirName = (dir: 'north' | 'south', lang: Lang) => t(lang, dir === 'north' ? 'dir.south' : 'dir.north');

function peakPhrase(p: ForecastDirPeak, lang: Lang): string {
  const at = p.peakHour === null ? '' : lang === 'de' ? ` um ${hourLabel(p.peakHour, lang)}` : ` around ${hourLabel(p.peakHour, lang)}`;
  return lang === 'de' ? `Spitze ca. ${p.peakMin} Min${at}` : `peak approx. ${p.peakMin} min${at}`;
}

function dirSentence(dir: 'north' | 'south', p: ForecastDirPeak, lang: Lang): string {
  const name = dirName(dir, lang);
  if (quiet(p)) return lang === 'de' ? `${name} kein nennenswerter Stau` : `${name.toLowerCase()} no relevant queue`;
  return `${lang === 'de' ? name : name.toLowerCase()} ${peakPhrase(p, lang)}`;
}

function cell(p: ForecastDirPeak, lang: Lang): string {
  if (quiet(p)) return lang === 'de' ? `kaum Stau (unter ${QUIET_PEAK_MIN} Min)` : `little or none (under ${QUIET_PEAK_MIN} min)`;
  const at = p.peakHour === null ? '' : ` · ${hourLabel(p.peakHour, lang)}`;
  return lang === 'de' ? `ca. ${p.peakMin} Min${at}` : `approx. ${p.peakMin} min${at}`;
}

/** "Busiest day …" sentence over `rows`, or '' when every day is quiet. */
function busiestSentence(rows: ForecastDayRow[], lang: Lang, prefix: string): string {
  let best: { row: ForecastDayRow; dir: 'north' | 'south'; min: number } | null = null;
  for (const row of rows) {
    for (const dir of ['north', 'south'] as const) {
      if (!best || row[dir].peakMin > best.min) best = { row, dir, min: row[dir].peakMin };
    }
  }
  if (!best || best.min < QUIET_PEAK_MIN) return '';
  const name = dirName(best.dir, lang);
  return lang === 'de'
    ? ` ${prefix}: ${dayLabel(best.row.date, lang)} (${name} ca. ${best.min} Min).`
    : ` ${prefix}: ${dayLabel(best.row.date, lang)} (${name.toLowerCase()} approx. ${best.min} min).`;
}

function table(rows: ForecastDayRow[], lang: Lang, todayIso: string, caption: string): string {
  const L = (de: string, en: string) => (lang === 'de' ? de : en);
  const body = rows
    .map((r) => {
      const today = r.date === todayIso ? `${L('Heute', 'Today')}, ` : '';
      const holiday = r.holiday ? ` <small>${esc(r.holiday[lang])}</small>` : '';
      return `<tr><th scope="row"><time datetime="${esc(r.date)}">${today}${esc(dayLabel(r.date, lang))}</time>${holiday}</th>`
        + `<td>${esc(cell(r.north, lang))}</td><td>${esc(cell(r.south, lang))}</td></tr>`;
    })
    .join('');
  return `<div class="table-scroll fc-ssr__scroll"><table class="data-table fc-ssr__table">`
    + `<caption>${esc(caption)}</caption>`
    + `<thead><tr><th scope="col">${L('Tag', 'Day')}</th><th scope="col">${esc(dirName('north', lang))}</th><th scope="col">${esc(dirName('south', lang))}</th></tr></thead>`
    + `<tbody>${body}</tbody></table></div>`;
}

const CAPTION_DIRS = {
  de: 'Richtung Süden = Stau vor dem Nordportal Göschenen, Richtung Norden = Stau vor dem Südportal Airolo',
  en: 'southbound = queue at the north portal Göschenen, northbound = queue at the south portal Airolo',
} as const;

/** Lead sentence + table for today and the next 7 days ('' when `rows` has no row for today). */
export function forecastWeekHtml(rows: ForecastDayRow[], lang: Lang, todayIso: string): string {
  const start = rows.findIndex((r) => r.date === todayIso);
  if (start < 0) return '';
  const week = rows.slice(start, start + WEEK_TABLE_DAYS);
  const today = week[0];
  const head = lang === 'de'
    ? `Prognose heute, ${dayLabel(today.date, lang)}${today.holiday ? ` (${today.holiday.de})` : ''}: `
    : `Forecast today, ${dayLabel(today.date, lang)}${today.holiday ? ` (${today.holiday.en})` : ''}: `;
  const both = quiet(today.north) && quiet(today.south)
    ? t(lang, 'forecast.noQueues')
    : `${dirSentence('north', today.north, lang)}, ${dirSentence('south', today.south, lang)}.`;
  const lead = head + both + busiestSentence(week.slice(1), lang, lang === 'de' ? 'Stärkster Tag der nächsten 7 Tage' : 'Busiest of the next 7 days');
  const caption = lang === 'de'
    ? `Erwartete Spitzenwartezeit pro Tag, heute und die nächsten 7 Tage (${CAPTION_DIRS.de})`
    : `Expected peak waiting time per day, today and the next 7 days (${CAPTION_DIRS.en})`;
  return `<div class="fc-ssr"><p class="fc-ssr__lead">${esc(lead)}</p>${table(week, lang, todayIso, caption)}</div>`;
}

/**
 * Table for the days `from`..`to` (inclusive, "YYYY-MM-DD"), skipping days
 * before today; '' when nothing is left or the range is invalid.
 */
export function forecastRangeHtml(rows: ForecastDayRow[], lang: Lang, todayIso: string, from: string, to: string): string {
  if (from > to) return '';
  const lo = from < todayIso ? todayIso : from;
  const inRange = rows.filter((r) => r.date >= lo && r.date <= to).slice(0, MAX_RANGE_DAYS);
  if (inRange.length === 0) return '';
  const span = `${dayLabel(inRange[0].date, lang)}–${dayLabel(inRange[inRange.length - 1].date, lang)}`;
  const busiest = busiestSentence(inRange, lang, lang === 'de' ? 'stärkster Tag' : 'busiest day');
  const lead = (lang === 'de' ? `Prognose ${span}` : `Forecast ${span}`)
    + (busiest !== '' ? `,${busiest}` : lang === 'de' ? ': keine nennenswerten Staus erwartet.' : ': no relevant queues expected.');
  const caption = lang === 'de'
    ? `Erwartete Spitzenwartezeit pro Tag, ${span} (${CAPTION_DIRS.de})`
    : `Expected peak waiting time per day, ${span} (${CAPTION_DIRS.en})`;
  return `<div class="fc-ssr"><p class="fc-ssr__lead">${esc(lead)}</p>${table(inRange, lang, todayIso, caption)}</div>`;
}
