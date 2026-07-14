import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { formatKm, formatMinutes, formatUpdated, statusLabel, passStatusLabel, buildSummary } from '../lib/format';
import { buildSparkline } from '../lib/chart';
import { generateForecast, type ForecastDay, type TrafficLevel } from '../lib/forecast';
import type { GotthardData, HistoryPoint } from '../lib/types';

const POLL_INTERVAL_MS = 60_000;

const lang = (() => {
  const attr = document.documentElement.dataset.lang;
  return isLang(attr) ? attr : DEFAULT_LANG;
})();

function setText(id: string, value: string) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setAttr(id: string, attr: string, value: string) {
  const el = document.getElementById(id);
  if (el) el.setAttribute(attr, value);
}

function renderClosures(side: 'north' | 'south', closures: string[] | undefined) {
  const el = document.getElementById(`${side}-closures`);
  if (!el) return;
  const items = closures ?? [];
  el.innerHTML = items.map(c => `<li class="card__closure-tag">${c}</li>`).join('');
  if (items.length > 0) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

function renderData(data: GotthardData) {
  setAttr('status-badge', 'data-status', data.tunnel.status);
  setText('status-label', statusLabel(data.tunnel.status, lang));
  setText('summary', buildSummary(data, lang));
  setText('hero-updated', formatUpdated(data.updated, lang));
  if (data.updated) setAttr('hero-updated', 'datetime', data.updated);

  setText('north-queue', formatKm(data.tunnel.north.queueKm, lang));
  setText('north-wait', formatMinutes(data.tunnel.north.waitMinutes, lang));
  if (data.tunnel.north.cause) setText('north-cause', data.tunnel.north.cause);
  renderClosures('north', data.tunnel.north.closures);

  setText('south-queue', formatKm(data.tunnel.south.queueKm, lang));
  setText('south-wait', formatMinutes(data.tunnel.south.waitMinutes, lang));
  if (data.tunnel.south.cause) setText('south-cause', data.tunnel.south.cause);
  renderClosures('south', data.tunnel.south.closures);

  setAttr('pass-badge', 'data-status', data.pass.status);
  setText('pass-status-label', passStatusLabel(data.pass.status, lang));
  if (data.pass.note) setText('pass-note', data.pass.note);

  setText('footer-source', data.source);
}

function renderHistory(history: HistoryPoint[]) {
  const chart = buildSparkline(history);
  const northPath = document.getElementById('trend-path-north');
  const southPath = document.getElementById('trend-path-south');
  if (northPath) northPath.setAttribute('d', chart.northPath);
  if (southPath) southPath.setAttribute('d', chart.southPath);

  const tbody = document.getElementById('trend-table-body');
  if (tbody) {
    tbody.innerHTML = history
      .map(
        (point) =>
          `<tr><td>${formatUpdated(point.t, lang)}</td><td>${formatKm(point.northQueueKm, lang)}</td><td>${formatKm(point.southQueueKm, lang)}</td></tr>`
      )
      .join('');
  }
}

// ─── Forecast rendering ───────────────────────────────────────────────────────

const LEVEL_LABEL: Record<TrafficLevel, Record<'de' | 'en', string>> = {
  low:      { de: 'Frei',           en: 'Clear' },
  moderate: { de: 'Mässig',         en: 'Moderate' },
  high:     { de: 'Stau erwartet',  en: 'Congestion' },
  extreme:  { de: 'Starker Stau',   en: 'Heavy jam' },
};

// Hours to show in the heatmap (05:00–21:00)
const SHOWN_HOURS = Array.from({ length: 17 }, (_, i) => i + 5);

function forecastCellTitle(h: number, northLevel: TrafficLevel, southLevel: TrafficLevel): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const nLabel = LEVEL_LABEL[northLevel][lang];
  const sLabel = LEVEL_LABEL[southLevel][lang];
  return `${pad(h)}:00 – Nord: ${nLabel} · Süd: ${sLabel}`;
}

function buildDayCard(day: ForecastDay, isToday: boolean): string {
  const todayBadge = isToday
    ? `<span class="forecast__today-badge">${lang === 'de' ? 'Heute' : 'Today'}</span>`
    : '';
  const ctxBadge = day.context
    ? `<span class="forecast__ctx-badge">${day.context}</span>`
    : '';
  const peakWarn = day.isPeak
    ? `<span class="forecast__peak-badge">${lang === 'de' ? 'Stau möglich' : 'Delays possible'}</span>`
    : '';

  const hourHeaders = SHOWN_HOURS.map(h => `<span class="forecast__hour-label">${h}</span>`).join('');

  const makeRow = (dirLabel: string, levelKey: 'northLevel' | 'southLevel', idxKey: 'northIdx' | 'southIdx') => {
    const cells = SHOWN_HOURS.map(h => {
      const hr = day.hours[h];
      const level = hr[levelKey];
      const title = forecastCellTitle(h, hr.northLevel, hr.southLevel);
      return `<div class="forecast__cell" data-level="${level}" title="${title}" aria-label="${title}"></div>`;
    }).join('');
    return `<div class="forecast__row">
      <span class="forecast__row-label">${dirLabel}</span>
      <div class="forecast__cells">${cells}</div>
    </div>`;
  };

  const northLabel = lang === 'de' ? 'Nord →IT' : 'North →IT';
  const southLabel = lang === 'de' ? 'Süd →CH'  : 'South →CH';

  return `<div class="forecast__day${day.isPeak ? ' forecast__day--peak' : ''}">
    <div class="forecast__day-header">
      <div class="forecast__day-name">${day.fullDayLabel}<span class="forecast__day-date">${day.dateLabel}</span></div>
      <div class="forecast__day-badges">${todayBadge}${ctxBadge}${peakWarn}</div>
    </div>
    <div class="forecast__grid">
      <div class="forecast__row forecast__row--labels">
        <span class="forecast__row-label"></span>
        <div class="forecast__cells">${hourHeaders}</div>
      </div>
      ${makeRow(northLabel, 'northLevel', 'northIdx')}
      ${makeRow(southLabel, 'southLevel', 'southIdx')}
    </div>
  </div>`;
}

function renderForecast() {
  const container = document.getElementById('forecast-days');
  if (!container) return;

  const now = new Date();
  const forecast = generateForecast(now, lang, 4);
  const todayIso = forecast[0]?.isoDate;

  container.innerHTML = forecast
    .map(day => buildDayCard(day, day.isoDate === todayIso))
    .join('');
}

// ─── Network helpers ──────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(`${url}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Try the DB-backed API endpoint first; fall back to the static JSON file so
// local Astro dev (no PHP) keeps working with the sample data in public/data/.
async function fetchWithFallback<T>(apiUrl: string, fallbackUrl: string): Promise<T | null> {
  const data = await fetchJson<T>(apiUrl);
  if (data !== null) return data;
  return fetchJson<T>(fallbackUrl);
}

async function tick() {
  const [data, history] = await Promise.all([
    fetchWithFallback<GotthardData>('/api/gotthard.php', '/data/gotthard.json'),
    fetchWithFallback<HistoryPoint[]>('/api/history.php', '/data/history.json'),
  ]);
  if (data) renderData(data);
  else setText('summary', t(lang, 'hero.dataUnavailable'));
  if (history) renderHistory(history);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

tick();
setInterval(tick, POLL_INTERVAL_MS);

// Forecast is purely calendar-based — render once on load, no polling needed
renderForecast();
