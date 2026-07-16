import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { formatKm, formatMinutes, formatUpdated, formatTrendDelta, TREND_ARROW, statusLabel, passStatusLabel, buildSummary, closureTitle, closureDetail } from '../lib/format';
import { buildSparkline, type SparklineResult } from '../lib/chart';
import { computeQueueTrend } from '../lib/trend';
import { generateForecast, generateDayCurve, swissDayInfo, type ForecastDay, type ForecastPoint, type TrafficLevel } from '../lib/forecast';
import { buildForecastChart, type ActualPoint, type ForecastChartResult } from '../lib/forecast-chart';
import { suggestDiversions } from '../lib/diversion';
import type { GotthardData, HistoryPoint, ClosureWindow } from '../lib/types';

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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string)
  );
}

function renderPlannedClosures(closures: ClosureWindow[] | undefined) {
  const el = document.getElementById('planned-closures');
  if (!el) return;
  const items = closures ?? [];
  el.innerHTML = items
    .map(
      (c) => `<div class="closure-banner__item" role="alert">
      <span class="closure-banner__icon" aria-hidden="true">⚠</span>
      <div class="closure-banner__text">
        <strong class="closure-banner__title">${escapeHtml(closureTitle(c, lang))}</strong>
        <span class="closure-banner__detail">${escapeHtml(closureDetail(c, lang))}</span>
      </div>
    </div>`
    )
    .join('');
  if (items.length > 0) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
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

  renderPlannedClosures(data.tunnel.plannedClosures);

  setText('footer-source', data.source);
}

function renderTrend(history: HistoryPoint[]) {
  for (const side of ['north', 'south'] as const) {
    const trend = computeQueueTrend(history, side === 'north' ? 'northQueueKm' : 'southQueueKm');
    const el = document.getElementById(`${side}-trend`);
    if (!el) continue;
    if (!trend) {
      el.setAttribute('hidden', '');
      continue;
    }
    el.removeAttribute('hidden');
    el.setAttribute('data-direction', trend.direction);
    el.textContent = `${TREND_ARROW[trend.direction]} ${formatTrendDelta(trend.deltaKm, lang)}`;
  }
}

// ─── 24h trend chart (interactive hover) ──────────────────────────────────────

interface TrendChartState {
  chart: SparklineResult;
}
let trendChartState: TrendChartState | null = null;
let trendHoverBound = false;

function bindTrendChartHover(svg: SVGSVGElement) {
  if (trendHoverBound) return;
  trendHoverBound = true;

  const wrap = svg.closest('.trend__chart-wrap') as HTMLElement | null;
  if (!wrap) return;
  wrap.style.position = 'relative';

  const tip = document.createElement('div');
  tip.className = 'trend__tooltip';
  tip.setAttribute('hidden', '');
  wrap.appendChild(tip);

  const clear = () => {
    tip.setAttribute('hidden', '');
    const g = document.getElementById('trend-hover');
    if (g) g.innerHTML = '';
  };

  const move = (clientX: number) => {
    const st = trendChartState;
    const g = document.getElementById('trend-hover');
    if (!st || !g || st.chart.points.length === 0) return;
    const { chart } = st;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chart.width;

    let idx = 0;
    let bestDist = Infinity;
    chart.points.forEach((p, i) => {
      const d = Math.abs(p.x - svgX);
      if (d < bestDist) { bestDist = d; idx = i; }
    });
    const p = chart.points[idx];

    g.innerHTML =
      `<line x1="${p.x}" y1="8" x2="${p.x}" y2="${chart.height - 24}" stroke="var(--color-text-muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />` +
      `<circle cx="${p.x}" cy="${p.yNorth}" r="4" fill="var(--color-accent)" stroke="var(--color-surface)" stroke-width="1.5" />` +
      `<circle cx="${p.x}" cy="${p.ySouth}" r="4" fill="var(--color-unknown)" stroke="var(--color-surface)" stroke-width="1.5" />`;

    const timeLabel = new Intl.DateTimeFormat(lang === 'de' ? 'de-CH' : 'en-CH', { hour: '2-digit', minute: '2-digit' }).format(new Date(p.t));
    tip.innerHTML =
      `<div class="trend__tt-time">${timeLabel}</div>` +
      `<div class="trend__tt-row"><span class="trend__tt-key"><span class="trend__tt-dot" style="background:var(--color-accent)"></span>${t(lang, 'trend.northLegend')}</span>` +
        `<span class="trend__tt-val">${formatKm(p.north, lang)}</span></div>` +
      `<div class="trend__tt-row"><span class="trend__tt-key"><span class="trend__tt-dot" style="background:var(--color-unknown)"></span>${t(lang, 'trend.southLegend')}</span>` +
        `<span class="trend__tt-val">${formatKm(p.south, lang)}</span></div>`;
    tip.removeAttribute('hidden');

    const wrapRect = wrap.getBoundingClientRect();
    const anchorX = rect.left - wrapRect.left + (p.x / chart.width) * rect.width;
    const tipW = tip.offsetWidth;
    let left = anchorX + 12;
    if (left + tipW > wrap.clientWidth - 4) left = anchorX - tipW - 12;
    if (left < 4) left = 4;
    tip.style.left = `${left}px`;
    tip.style.top = '4px';
  };

  svg.addEventListener('pointermove', (e) => move(e.clientX));
  svg.addEventListener('pointerleave', clear);
  svg.style.touchAction = 'pan-y';
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

  trendChartState = { chart };
  const svg = document.getElementById('trend-svg');
  if (svg) bindTrendChartHover(svg as unknown as SVGSVGElement);

  renderTrend(history);
}

// ─── 10-minute prediction chart ───────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, '0'); }
function minuteToHHMM(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${pad2(h)}:${pad2(m % 60)}`;
}

// Current chart geometry + data, kept so the hover handler can look up values.
interface FChartState {
  chart: ForecastChartResult;
  points: ForecastPoint[];
  actual: ActualPoint[];
  nowMin: number;
}
let fchartState: FChartState | null = null;
let fchartHoverBound = false;

function renderForecastChart(history: HistoryPoint[]) {
  const svg = document.getElementById('forecast-chart');
  if (!svg) return;

  const now = new Date();
  const curve = generateDayCurve(now, lang);
  const nowMin = swissDayInfo(now).minuteOfDay;

  // Keep only today's measured points, aligned to Swiss local minute-of-day.
  const actual: ActualPoint[] = [];
  for (const p of history) {
    const info = swissDayInfo(new Date(p.t));
    if (info.isoDate !== curve.isoDate) continue;
    actual.push({ minuteOfDay: info.minuteOfDay, north: p.northWaitMinutes, south: p.southWaitMinutes });
  }

  const chart = buildForecastChart(curve.points, actual, nowMin);
  svg.setAttribute('viewBox', `0 0 ${chart.width} ${chart.height}`);

  const dash = (label: string) => label === '0' ? '' : 'stroke-dasharray="4 3"';
  const grid = chart.yTicks
    .map(tk => `<line x1="${chart.plot.left}" y1="${tk.y}" x2="${chart.plot.right}" y2="${tk.y}" stroke="var(--color-border)" stroke-width="1" ${dash(tk.label)} />`)
    .join('');
  const yLabels = chart.yTicks
    .map(tk => `<text x="${chart.plot.left - 6}" y="${(tk.y as number) + 3}" text-anchor="end" font-size="10" fill="var(--color-text-muted)" font-family="var(--font-sans)">${tk.label}</text>`)
    .join('');
  const xLabels = chart.xTicks
    .map(tk => `<text x="${tk.x}" y="${chart.plot.bottom + 14}" text-anchor="middle" font-size="10" fill="var(--color-text-muted)" font-family="var(--font-sans)">${tk.label}</text>`)
    .join('');

  const nowLabel = lang === 'de' ? 'jetzt' : 'now';
  const nowMarker = chart.nowX === null ? '' :
    `<line x1="${chart.nowX}" y1="${chart.plot.top}" x2="${chart.nowX}" y2="${chart.plot.bottom}" stroke="var(--color-accent)" stroke-width="1" stroke-dasharray="2 2" opacity="0.6" />
     <text x="${chart.nowX}" y="${chart.plot.top + 8}" text-anchor="middle" font-size="9" fill="var(--color-accent)" font-family="var(--font-sans)">${nowLabel}</text>`;

  const paths =
    `<path d="${chart.northForecast}" fill="none" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.65" stroke-linejoin="round" />
     <path d="${chart.southForecast}" fill="none" stroke="var(--color-unknown)" stroke-width="1.5" stroke-dasharray="5 4" opacity="0.65" stroke-linejoin="round" />
     <path d="${chart.northActual}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
     <path d="${chart.southActual}" fill="none" stroke="var(--color-unknown)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;

  svg.innerHTML = `<desc id="fchart-desc">${t(lang, 'fchart.title')}</desc>${grid}${yLabels}${xLabels}${nowMarker}${paths}<g id="fchart-hover" style="pointer-events:none"></g>`;

  fchartState = { chart, points: curve.points, actual, nowMin };
  bindForecastChartHover(svg as unknown as SVGSVGElement);

  // Dynamic subtitle: day + holiday context + predicted daily peak.
  const subtitle = document.getElementById('fchart-subtitle');
  if (subtitle) {
    let peak = 0, peakMin = 0;
    for (const p of curve.points) {
      const w = Math.max(p.northWait, p.southWait);
      if (w > peak) { peak = w; peakMin = p.minuteOfDay; }
    }
    const ctx = curve.context ? ` · ${curve.context}` : '';
    subtitle.textContent = peak > 0
      ? (lang === 'de'
          ? `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Vorhergesagte Spitze ca. ${peak} Min gegen ${minuteToHHMM(peakMin)}`
          : `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Predicted peak ~${peak} min around ${minuteToHHMM(peakMin)}`)
      : (lang === 'de'
          ? `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Kaum Stau erwartet`
          : `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Little congestion expected`);
  }
}

// ─── Prediction chart hover (split Nord / Süd) ────────────────────────────────

function fchartXOf(min: number, c: ForecastChartResult): number {
  return c.plot.left + (c.plot.right - c.plot.left) * (min / 1440);
}
function fchartYOf(min: number, c: ForecastChartResult): number {
  const innerH = c.plot.bottom - c.plot.top;
  return c.plot.bottom - (Math.min(min, c.maxMin) / c.maxMin) * innerH;
}

// Nearest measured point to `min`, only if it's in the past and reasonably close.
function nearestActual(actual: ActualPoint[], nowMin: number, min: number): ActualPoint | null {
  let best: ActualPoint | null = null;
  let bestDist = 45; // don't attach a measurement more than 45 min away
  for (const p of actual) {
    if (p.minuteOfDay > nowMin) continue;
    const d = Math.abs(p.minuteOfDay - min);
    if (d <= bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function bindForecastChartHover(svg: SVGSVGElement) {
  if (fchartHoverBound) return;
  fchartHoverBound = true;

  const wrap = svg.closest('.fchart__wrap') as HTMLElement | null;
  if (!wrap) return;
  wrap.style.position = 'relative';

  const tip = document.createElement('div');
  tip.className = 'fchart__tooltip';
  tip.setAttribute('hidden', '');
  wrap.appendChild(tip);

  const clear = () => {
    tip.setAttribute('hidden', '');
    const g = document.getElementById('fchart-hover');
    if (g) g.innerHTML = '';
  };

  const move = (clientX: number, clientY: number) => {
    const st = fchartState;
    const g = document.getElementById('fchart-hover');
    if (!st || !g) return;
    const { chart, points, actual, nowMin } = st;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chart.width;

    // Snap to the nearest 10-minute forecast sample.
    let min = ((svgX - chart.plot.left) / (chart.plot.right - chart.plot.left)) * 1440;
    min = Math.max(0, Math.min(1440, min));
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(min / 10)));
    const fp = points[idx];
    const px = fchartXOf(fp.minuteOfDay, chart);

    const meas = nearestActual(actual, nowMin, fp.minuteOfDay);

    // Hover guides: vertical line + predicted dots (+ measured dots when present).
    const dot = (yMin: number, color: string, filled: boolean) =>
      `<circle cx="${px.toFixed(1)}" cy="${fchartYOf(yMin, chart).toFixed(1)}" r="3.5" fill="${filled ? color : 'var(--color-surface)'}" stroke="${color}" stroke-width="1.5" />`;
    g.innerHTML =
      `<line x1="${px.toFixed(1)}" y1="${chart.plot.top}" x2="${px.toFixed(1)}" y2="${chart.plot.bottom}" stroke="var(--color-text-muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />` +
      dot(fp.northWait, 'var(--color-accent)', false) +
      dot(fp.southWait, 'var(--color-unknown)', false) +
      (meas ? (meas.north !== null ? dot(meas.north, 'var(--color-accent)', true) : '') : '') +
      (meas ? (meas.south !== null ? dot(meas.south, 'var(--color-unknown)', true) : '') : '');

    // Tooltip: split Nord / Süd, predicted always, measured when available.
    const nLabel = lang === 'de' ? 'Nord →IT' : 'North →IT';
    const sLabel = lang === 'de' ? 'Süd →CH' : 'South →CH';
    const predWord = lang === 'de' ? 'Prognose' : 'Forecast';
    const measWord = lang === 'de' ? 'Gemessen' : 'Measured';
    const unit = lang === 'de' ? 'Min' : 'min';
    const measRow = (val: number | null | undefined) =>
      val === null || val === undefined ? '' :
      `<div class="fchart__tt-sub">${measWord}: ${Math.round(val)} ${unit}</div>`;

    tip.innerHTML =
      `<div class="fchart__tt-time">${minuteToHHMM(fp.minuteOfDay)}</div>` +
      `<div class="fchart__tt-row"><span class="fchart__tt-key"><span class="fchart__tt-dot" style="background:var(--color-accent)"></span>${nLabel}</span>` +
        `<span class="fchart__tt-val">${predWord}: ${fp.northWait} ${unit}</span></div>` +
      measRow(meas?.north) +
      `<div class="fchart__tt-row"><span class="fchart__tt-key"><span class="fchart__tt-dot" style="background:var(--color-unknown)"></span>${sLabel}</span>` +
        `<span class="fchart__tt-val">${predWord}: ${fp.southWait} ${unit}</span></div>` +
      measRow(meas?.south);

    tip.removeAttribute('hidden');

    // Position tooltip near the snapped x, flipping side to stay in view.
    const wrapRect = wrap.getBoundingClientRect();
    const anchorX = rect.left - wrapRect.left + (px / chart.width) * rect.width;
    const tipW = tip.offsetWidth;
    let left = anchorX + 12;
    if (left + tipW > wrap.clientWidth - 4) left = anchorX - tipW - 12;
    if (left < 4) left = 4;
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(4, clientY - wrapRect.top - tip.offsetHeight - 10)}px`;
  };

  svg.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  svg.addEventListener('pointerleave', clear);
  svg.style.touchAction = 'pan-y';
}

// ─── Diversion suggestions ─────────────────────────────────────────────────────

function renderDiversions(data: GotthardData) {
  const section = document.getElementById('diversion-section');
  const list = document.getElementById('diversion-list');
  const lead = document.getElementById('diversion-lead');
  if (!section || !list || !lead) return;

  const res = suggestDiversions(data, lang);
  if (!res.trigger) {
    section.setAttribute('hidden', '');
    return;
  }
  section.removeAttribute('hidden');

  lead.textContent = lang === 'de'
    ? `Aktuell ca. ${res.worstWait} Min Wartezeit (${res.directionLabel}). Mögliche Ausweichrouten:`
    : `Currently about ${res.worstWait} min wait (${res.directionLabel}). Possible alternative routes:`;

  const recLabel = lang === 'de' ? 'Schneller als warten' : 'Faster than waiting';
  const detour = (min: number) => lang === 'de' ? `+${min} Min Umweg` : `+${min} min detour`;

  list.innerHTML = res.routes.map(r => {
    const cls = `diversion__item${r.recommended ? ' diversion__item--rec' : ''}${!r.available ? ' diversion__item--off' : ''}`;
    const badge = r.recommended ? `<span class="diversion__badge">${recLabel}</span>` : '';
    const note = r.note ? ` <em class="diversion__note">${r.note}</em>` : '';
    return `<li class="${cls}">
      <div class="diversion__item-head">
        <span class="diversion__item-name">${r.name}${badge}</span>
        <span class="diversion__item-time">${detour(r.extraMinutes)}</span>
      </div>
      <p class="diversion__item-desc">${r.description}${note}</p>
    </li>`;
  }).join('');
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

  const makeRow = (dirLabel: string, levelKey: 'northLevel' | 'southLevel', _idxKey: 'northIdx' | 'southIdx') => {
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
    .map((day: ForecastDay) => buildDayCard(day, day.isoDate === todayIso))
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
  if (data) {
    renderData(data);
    renderDiversions(data);
  } else {
    setText('summary', t(lang, 'hero.dataUnavailable'));
  }
  if (history) renderHistory(history);
  renderForecastChart(history ?? []);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

tick();
setInterval(tick, POLL_INTERVAL_MS);

// Forecast heatmap is purely calendar-based — render once on load, no polling needed
renderForecast();
// Render the prediction curve immediately so the chart isn't empty before the first fetch
renderForecastChart([]);
