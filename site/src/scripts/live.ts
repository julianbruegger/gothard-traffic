import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { formatKm, formatMinutes, formatUpdated, formatTrendDelta, TREND_ARROW, statusLabel, passStatusLabel, buildSummary, closureTitle, closureDetail } from '../lib/format';
import { buildSparkline, type SparklineResult } from '../lib/chart';
import { computeQueueTrend } from '../lib/trend';
import { generateForecast, generateDayCurve, swissDayInfo, type ForecastDay, type ForecastPoint, type TrafficLevel } from '../lib/forecast';
import { buildForecastChart, type ActualPoint, type Direction, type ForecastChartResult } from '../lib/forecast-chart';
import { historicDatesForWeekday, historicDaySeries, historicMeta } from '../lib/historic-days';
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
      el.removeAttribute('data-direction');
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
const trendTimeFormatter = new Intl.DateTimeFormat(lang === 'de' ? 'de-CH' : 'en-CH', { hour: '2-digit', minute: '2-digit' });

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

    const dot = (cy: number, color: string) =>
      `<circle cx="${p.x}" cy="${cy}" r="4" fill="${color}" stroke="var(--color-surface)" stroke-width="1.5" />`;
    g.innerHTML =
      `<line x1="${p.x}" y1="8" x2="${p.x}" y2="${chart.height - 24}" stroke="var(--color-text-muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />` +
      (p.north !== null ? dot(p.yNorth, 'var(--color-accent)') : '') +
      (p.south !== null ? dot(p.ySouth, 'var(--color-unknown)') : '');

    const timeLabel = trendTimeFormatter.format(new Date(p.t));
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

// Swiss-local weekday of `now` (0 = Sunday .. 6 = Saturday).
function swissDow(now: Date): number {
  return new Date(`${swissDayInfo(now).isoDate}T12:00:00Z`).getUTCDay();
}

function isoDateLabel(iso: string): string {
  const [, m, d] = iso.split('-');
  return lang === 'de' ? `${d}.${m}.` : `${m}/${d}`;
}

// fchartDayOffset: days from today (Swiss local), can be negative. Bound to the
// current Mon–Sun week, matching the day tabs. fchartDirection: which portal's
// curve is currently drawn (the chart shows one direction at a time).
let fchartDayOffset = 0;
let fchartDirection: Direction = 'north';
let lastHistory: HistoryPoint[] = [];

// Current chart geometry + data, kept so the hover handler can look up values.
interface FChartState {
  chart: ForecastChartResult;
  points: ForecastPoint[];
  actual: ActualPoint[];
  nowMin: number | null;
  direction: Direction;
}
let fchartState: FChartState | null = null;
let fchartHoverBound = false;

function renderDayTabs(now: Date) {
  const nav = document.getElementById('fchart-daynav');
  if (!nav) return;

  const mondayOffset = -((swissDow(now) + 6) % 7);
  const items: Array<{ offset: number; label: string; isToday: boolean }> = [];
  for (let i = 0; i < 7; i++) {
    const offset = mondayOffset + i;
    const from = new Date(now.getTime() + offset * 86_400_000);
    const day = generateForecast(from, lang, 1)[0];
    if (day) items.push({ offset, label: day.dayLabel, isToday: offset === 0 });
  }

  nav.innerHTML = items
    .map(it => `<button type="button" class="fchart__day-tab" data-offset="${it.offset}" data-today="${it.isToday}">${it.label}</button>`)
    .join('');
  updateDayTabsActive();
}

function updateDayTabsActive() {
  document.querySelectorAll<HTMLButtonElement>('#fchart-daynav .fchart__day-tab').forEach(btn => {
    btn.setAttribute('data-active', String(Number(btn.dataset.offset) === fchartDayOffset));
  });
}

function bindDayNav() {
  document.getElementById('fchart-daynav')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.fchart__day-tab') as HTMLButtonElement | null;
    if (!btn) return;
    fchartDayOffset = Number(btn.dataset.offset);
    updateDayTabsActive();
    renderForecastChart(lastHistory);
  });
}

function updatePortalToggle() {
  document.getElementById('fchart-portal-north')?.setAttribute('data-active', String(fchartDirection === 'north'));
  document.getElementById('fchart-portal-south')?.setAttribute('data-active', String(fchartDirection === 'south'));
}

function bindPortalToggle() {
  document.getElementById('fchart-portal-north')?.addEventListener('click', () => {
    fchartDirection = 'north';
    updatePortalToggle();
    renderForecastChart(lastHistory);
  });
  document.getElementById('fchart-portal-south')?.addEventListener('click', () => {
    fchartDirection = 'south';
    updatePortalToggle();
    renderForecastChart(lastHistory);
  });
}

function renderForecastChart(history: HistoryPoint[]) {
  const svg = document.getElementById('forecast-chart');
  if (!svg) return;

  const now = new Date();
  const isToday = fchartDayOffset === 0;
  const from = new Date(now.getTime() + fchartDayOffset * 86_400_000);
  const curve = generateDayCurve(from, lang);
  const nowMin = isToday ? swissDayInfo(now).minuteOfDay : null;

  // Keep only the selected day's measured points (today only — live history
  // doesn't reach back to other days), aligned to Swiss local minute-of-day.
  const actual: ActualPoint[] = [];
  if (isToday) {
    for (const p of history) {
      const info = swissDayInfo(new Date(p.t));
      if (info.isoDate !== curve.isoDate) continue;
      actual.push({ minuteOfDay: info.minuteOfDay, north: p.northWaitMinutes, south: p.southWaitMinutes });
    }
  }

  // Real same-weekday historic days, sourced from TCS traffic reports.
  const dow = new Date(`${curve.isoDate}T12:00:00Z`).getUTCDay();
  const gridMinutes = curve.points.map(p => p.minuteOfDay);
  const dirKey = fchartDirection === 'north' ? 'n' : 's';
  const historic = historicDatesForWeekday(dow)
    .slice(0, 3)
    .map(iso => historicDaySeries(iso, dirKey, gridMinutes))
    .filter((h): h is NonNullable<typeof h> => h !== null);

  const chart = buildForecastChart(curve.points, actual, nowMin, fchartDirection, historic);
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

  const band = chart.bandPath
    ? `<path d="${chart.bandPath}" fill="rgba(139, 92, 246, 0.10)" stroke="none" />`
    : '';
  const historicPaths = chart.historic
    .map(h => `<path d="${h.path}" fill="none" stroke="${h.color}" stroke-width="1.5" stroke-linejoin="round" />`)
    .join('');

  const paths =
    `<path d="${chart.forecastPath}" fill="none" stroke="var(--color-accent)" stroke-width="1.75" stroke-dasharray="5 4" opacity="0.8" stroke-linejoin="round" />
     <path d="${chart.actualPath}" fill="none" stroke="var(--color-accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;

  svg.innerHTML = `<desc id="fchart-desc">${t(lang, 'fchart.title')}</desc>${band}${grid}${yLabels}${xLabels}${historicPaths}${nowMarker}${paths}<g id="fchart-hover" style="pointer-events:none"></g>`;

  fchartState = { chart, points: curve.points, actual, nowMin, direction: fchartDirection };
  bindForecastChartHover(svg as unknown as SVGSVGElement);

  // Legend: the solid "measured" line only exists for today.
  const legendActual = document.getElementById('fchart-legend-actual');
  if (legendActual) legendActual.hidden = !(isToday && chart.actualPath !== '');

  const legendHistoric = document.getElementById('fchart-legend-historic');
  if (legendHistoric) {
    legendHistoric.innerHTML = chart.historic
      .map(h => `<span class="fchart__legend-item"><span class="fchart__legend-swatch" style="background:${h.color}"></span>${isoDateLabel(h.isoDate)}</span>`)
      .join('');
  }

  const note = document.getElementById('fchart-note');
  if (note) {
    if (chart.historic.length === 0) {
      note.textContent = `${t(lang, 'fchart.noHistoric')} ${historicMeta.dateStart} – ${historicMeta.dateEnd}.`;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  // Dynamic subtitle: day + holiday context + predicted daily peak (selected direction).
  const subtitle = document.getElementById('fchart-subtitle');
  if (subtitle) {
    let peak = 0, peakMin = 0;
    for (const p of curve.points) {
      const w = fchartDirection === 'north' ? p.northWait : p.southWait;
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

// ─── Prediction chart hover ────────────────────────────────────────────────────

function fchartXOf(min: number, c: ForecastChartResult): number {
  return c.plot.left + (c.plot.right - c.plot.left) * (min / 1440);
}
function fchartYOf(min: number, c: ForecastChartResult): number {
  const innerH = c.plot.bottom - c.plot.top;
  return c.plot.bottom - (Math.min(min, c.maxMin) / c.maxMin) * innerH;
}

// Nearest measured value to `min`, only if it's in the past and reasonably close.
function nearestActual(actual: ActualPoint[], nowMin: number | null, min: number, dir: Direction): number | null {
  let best: number | null = null;
  let bestDist = 45; // don't attach a measurement more than 45 min away
  for (const p of actual) {
    if (nowMin !== null && p.minuteOfDay > nowMin) continue;
    const v = dir === 'north' ? p.north : p.south;
    if (v === null) continue;
    const d = Math.abs(p.minuteOfDay - min);
    if (d <= bestDist) { bestDist = d; best = v; }
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
    const { chart, points, actual, nowMin, direction } = st;

    const rect = svg.getBoundingClientRect();
    if (rect.width === 0) return;
    const svgX = ((clientX - rect.left) / rect.width) * chart.width;

    // Snap to the nearest 10-minute forecast sample.
    let min = ((svgX - chart.plot.left) / (chart.plot.right - chart.plot.left)) * 1440;
    min = Math.max(0, Math.min(1440, min));
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(min / 10)));
    const fp = points[idx];
    const px = fchartXOf(fp.minuteOfDay, chart);
    const predicted = direction === 'north' ? fp.northWait : fp.southWait;

    const meas = nearestActual(actual, nowMin, fp.minuteOfDay, direction);

    // Hover guides: vertical line + predicted dot, measured dot, historic dots.
    const dot = (yMin: number, color: string, filled: boolean) =>
      `<circle cx="${px.toFixed(1)}" cy="${fchartYOf(yMin, chart).toFixed(1)}" r="3.5" fill="${filled ? color : 'var(--color-surface)'}" stroke="${color}" stroke-width="1.5" />`;
    g.innerHTML =
      `<line x1="${px.toFixed(1)}" y1="${chart.plot.top}" x2="${px.toFixed(1)}" y2="${chart.plot.bottom}" stroke="var(--color-text-muted)" stroke-width="1" stroke-dasharray="3 3" opacity="0.6" />` +
      dot(predicted, 'var(--color-accent)', false) +
      (meas !== null ? dot(meas, 'var(--color-accent)', true) : '') +
      chart.historic.map(h => dot(h.values[idx], h.color, true)).join('');

    // Tooltip: predicted always, measured (today) and historic values (if any) below.
    const dirLabel = direction === 'north' ? t(lang, 'forecast.north') : t(lang, 'forecast.south');
    const predWord = lang === 'de' ? 'Prognose' : 'Forecast';
    const measWord = lang === 'de' ? 'Gemessen' : 'Measured';
    const unit = lang === 'de' ? 'Min' : 'min';

    let sub = meas !== null ? `<div class="fchart__tt-sub">${measWord}: ${Math.round(meas)} ${unit}</div>` : '';
    sub += chart.historic
      .map(h => `<div class="fchart__tt-sub" style="color:${h.color}">${isoDateLabel(h.isoDate)}: ${Math.round(h.values[idx])} ${unit}</div>`)
      .join('');

    tip.innerHTML =
      `<div class="fchart__tt-time">${minuteToHHMM(fp.minuteOfDay)}</div>` +
      `<div class="fchart__tt-row"><span class="fchart__tt-key"><span class="fchart__tt-dot" style="background:var(--color-accent)"></span>${dirLabel}</span>` +
        `<span class="fchart__tt-val">${predWord}: ${Math.round(predicted)} ${unit}</span></div>` +
      sub;

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
  lastHistory = history ?? [];
  renderForecastChart(lastHistory);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

tick();
setInterval(tick, POLL_INTERVAL_MS);

// Forecast heatmap is purely calendar-based — render once on load, no polling needed
renderForecast();
// Day tabs + portal toggle are calendar-based too — set up once, no polling needed
renderDayTabs(new Date());
bindDayNav();
bindPortalToggle();
// Render the prediction curve immediately so the chart isn't empty before the first fetch
renderForecastChart([]);
