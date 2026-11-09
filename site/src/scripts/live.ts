import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { formatKm, formatMinutes, formatUpdated, formatTrendDelta, statusLabel, passStatusLabel, buildSummary, closureTitle, closureDetail } from '../lib/format';
import { buildSparkline, type SparklineResult } from '../lib/chart';
import { computeQueueTrend } from '../lib/trend';
import { generateForecast, generateDayCurve, swissDayInfo, idxToWaitMinutes, type ForecastPoint, type TrafficLevel } from '../lib/forecast';
import { iconSvg } from '../lib/icons';
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
      <span class="closure-banner__icon">${iconSvg('warning', 24)}</span>
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

  for (const side of ['north', 'south'] as const) {
    const portal = data.tunnel[side];
    setText(`${side}-queue`, formatKm(portal.queueKm, lang));
    setText(`${side}-wait`, formatMinutes(portal.waitMinutes, lang));
    setText(`${side}-cause`, portal.cause ?? '');
    document.getElementById(`${side}-cause-row`)?.toggleAttribute('hidden', !portal.cause);
    // Queue meter: 0–15 km track (longer queues pin the bar full).
    const meter = document.getElementById(`${side}-meter`);
    if (meter) meter.style.width = `${Math.min(100, Math.max(0, ((portal.queueKm ?? 0) / 15) * 100)).toFixed(1)}%`;
    const free = data.tunnel.status !== 'closed' && (!portal.queueKm || portal.queueKm <= 0);
    document.getElementById(`${side}-free`)?.toggleAttribute('hidden', !free);
    renderClosures(side, portal.closures);
  }

  setAttr('pass-badge', 'data-status', data.pass.status);
  setText('pass-status-label', passStatusLabel(data.pass.status, lang));
  setText('pass-note', data.pass.note ?? '');
  document.getElementById('pass-note-row')?.toggleAttribute('hidden', !data.pass.note);

  // Restart the 60 s refresh bar so it tracks the real poll cycle.
  const fill = document.getElementById('refresh-fill');
  if (fill) { fill.style.animation = 'none'; void fill.offsetWidth; fill.style.animation = ''; }

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
    setText(`${side}-trend-text`, formatTrendDelta(trend.deltaKm, lang));
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
      (p.north !== null ? dot(p.yNorth, 'var(--c-north)') : '') +
      (p.south !== null ? dot(p.ySouth, 'var(--c-south)') : '');

    const timeLabel = trendTimeFormatter.format(new Date(p.t));
    tip.innerHTML =
      `<div class="trend__tt-time">${timeLabel}</div>` +
      `<div class="trend__tt-row"><span class="trend__tt-key"><span class="trend__tt-dot" style="background:var(--c-north)"></span>${t(lang, 'dir.south')}</span>` +
        `<span class="trend__tt-val">${formatKm(p.north, lang)}</span></div>` +
      `<div class="trend__tt-row"><span class="trend__tt-key"><span class="trend__tt-dot" style="background:var(--c-south)"></span>${t(lang, 'dir.north')}</span>` +
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

function kmLabel(v: number): string {
  return `${String(v).replace('.', lang === 'de' ? ',' : '.')} km`;
}

function renderSparks(history: HistoryPoint[]) {
  const spark = buildSparkline(history, 280, 56, { padX: 2, padTop: 4, padBottom: 2, minMaxKm: 5 });
  for (const side of ['north', 'south'] as const) {
    setAttr(`${side}-spark-line`, 'd', side === 'north' ? spark.northPath : spark.southPath);
    setAttr(`${side}-spark-gap`, 'd', side === 'north' ? spark.northGapPath : spark.southGapPath);
    const g = document.getElementById(`${side}-spark-closed`);
    if (g) g.innerHTML = spark.closures.map((b) => `<rect x="${b.x1}" y="0" width="${Math.max(b.x2 - b.x1, 1)}" height="56" fill="var(--closed-bg)" />`).join('');
  }
}

function chartWidth(svg: Element, fallback: number): number {
  const w = (svg.parentElement as HTMLElement | null)?.clientWidth ?? 0;
  return w > 0 ? Math.round(Math.max(300, Math.min(1200, w))) : fallback;
}

function renderHistory(history: HistoryPoint[]) {
  const trendSvg = document.getElementById('trend-svg');
  const chart = buildSparkline(history, trendSvg ? chartWidth(trendSvg, 640) : 640, 220);
  trendSvg?.setAttribute('viewBox', `0 0 ${chart.width} ${chart.height}`);
  setAttr('trend-path-north', 'd', chart.northPath);
  setAttr('trend-path-south', 'd', chart.southPath);
  setAttr('trend-gap-north', 'd', chart.northGapPath);
  setAttr('trend-gap-south', 'd', chart.southGapPath);

  const closuresGroup = document.getElementById('trend-closures');
  if (closuresGroup) {
    const closedLabel = escapeHtml(t(lang, 'trend.closedLabel'));
    closuresGroup.innerHTML = chart.closures
      .map((b) => `<rect x="${b.x1}" y="8" width="${Math.max(b.x2 - b.x1, 1)}" height="${chart.height - 32}" fill="var(--closed-bg)"><title>${closedLabel}</title></rect>`)
      .join('');
  }
  const grid = document.getElementById('trend-grid');
  if (grid) {
    grid.innerHTML = chart.yTicks
      .map((tk) =>
        `<line x1="8" x2="${chart.width - 8}" y1="${tk.y}" y2="${tk.y}" stroke="${tk.km === 0 ? 'var(--md-outline)' : 'var(--md-outline-variant)'}" stroke-width="1" />` +
        (tk.km > 0 ? `<text x="10" y="${tk.y - 4}" font-size="11" fill="var(--md-on-surface-variant)">${kmLabel(tk.km)}</text>` : ''))
      .join('');
  }
  const ticks = document.getElementById('trend-ticks');
  if (ticks) {
    ticks.innerHTML = chart.ticks
      .map((tk) => `<text x="${tk.x}" y="${chart.height - 6}" text-anchor="middle" font-size="11" fill="var(--md-on-surface-variant)">${tk.label}</text>`)
      .join('');
  }

  const tbody = document.getElementById('trend-table-body');
  if (tbody) {
    const closedCell = escapeHtml(t(lang, 'status.closed'));
    tbody.innerHTML = history
      .map((point) => {
        const isClosed = point.status === 'closed';
        return `<tr${isClosed ? ' data-closed=""' : ''}><td>${formatUpdated(point.t, lang)}</td><td class="num">${isClosed ? '–' : formatKm(point.northQueueKm, lang)}</td><td class="num">${isClosed ? '–' : formatKm(point.southQueueKm, lang)}</td><td>${isClosed ? closedCell : '–'}</td></tr>`;
      })
      .join('');
  }

  trendChartState = { chart };
  const svg = document.getElementById('trend-svg');
  if (svg) bindTrendChartHover(svg as unknown as SVGSVGElement);

  renderSparks(history);
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
    .map(it => `<button type="button" class="filter-chip fchart__day-tab" data-offset="${it.offset}" data-today="${it.isToday}" aria-pressed="false">${iconSvg('check', 18, 'icon seg__check')}${it.isToday ? (lang === 'de' ? 'Heute' : 'Today') : it.label}</button>`)
    .join('');
  updateDayTabsActive();
}

function updateDayTabsActive() {
  document.querySelectorAll<HTMLButtonElement>('#fchart-daynav .fchart__day-tab').forEach(btn => {
    const active = Number(btn.dataset.offset) === fchartDayOffset;
    btn.setAttribute('data-active', String(active));
    btn.setAttribute('aria-pressed', String(active));
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
  for (const dir of ['north', 'south'] as const) {
    const btn = document.getElementById(`fchart-portal-${dir}`);
    btn?.setAttribute('data-active', String(fchartDirection === dir));
    btn?.setAttribute('aria-pressed', String(fchartDirection === dir));
  }
  document.getElementById('fchart-section')?.setAttribute('data-direction', fchartDirection);
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
      actual.push({ minuteOfDay: info.minuteOfDay, north: p.northWaitMinutes, south: p.southWaitMinutes, closed: p.status === 'closed' });
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

  // Draw at the container's real width so labels keep their size on a phone.
  const w = chartWidth(svg, 640);
  const chart = buildForecastChart(curve.points, actual, nowMin, fchartDirection, historic, w, w < 520 ? 240 : 270);
  svg.setAttribute('viewBox', `0 0 ${chart.width} ${chart.height}`);

  const grid = chart.yTicks
    .map(tk => `<line x1="${chart.plot.left}" y1="${tk.y}" x2="${chart.plot.right}" y2="${tk.y}" stroke="${tk.label === '0' ? 'var(--md-outline)' : 'var(--md-outline-variant)'}" stroke-width="1" />`)
    .join('');
  const unit = lang === 'de' ? 'Min' : 'min';
  const yLabels = chart.yTicks
    .map((tk, i) => `<text x="${chart.plot.left - 6}" y="${(tk.y as number) + 3}" text-anchor="end" font-size="10" fill="var(--md-on-surface-variant)">${tk.label}${i === chart.yTicks.length - 1 ? ` ${unit}` : ''}</text>`)
    .join('');
  const xLabels = chart.xTicks
    .map(tk => `<text x="${tk.x}" y="${chart.plot.bottom + 14}" text-anchor="middle" font-size="10" fill="var(--md-on-surface-variant)">${tk.label}</text>`)
    .join('');
  const closedBands = chart.closedBands
    .map(b => `<rect x="${b.x1}" y="${chart.plot.top}" width="${Math.max(b.x2 - b.x1, 1)}" height="${chart.plot.bottom - chart.plot.top}" fill="var(--closed-bg)" />`)
    .join('');

  const nowLabel = lang === 'de' ? 'jetzt' : 'now';
  const nowMarker = chart.nowX === null ? '' :
    `<line x1="${chart.nowX}" y1="${chart.plot.top}" x2="${chart.nowX}" y2="${chart.plot.bottom}" stroke="var(--md-on-surface)" stroke-width="1" />
     <text x="${chart.nowX}" y="${chart.plot.top - 1}" text-anchor="middle" font-size="10" font-weight="600" fill="var(--md-on-surface)">${nowLabel}</text>`;

  // Shaded typical→busy-day forecast range, with a faint dashed upper edge.
  const fcBand = chart.forecastBandPath
    ? `<path d="${chart.forecastBandPath}" fill="var(--series-tint)" stroke="none" />`
    : '';
  const fcHigh = chart.forecastHighPath
    ? `<path d="${chart.forecastHighPath}" fill="none" stroke="var(--series)" stroke-width="1" stroke-dasharray="2 3" opacity="0.45" stroke-linejoin="round" />`
    : '';
  const historicPaths = chart.historic
    .map(h => `<path d="${h.path}" fill="none" stroke="${h.color}" stroke-width="1.5" stroke-linejoin="round" />`)
    .join('');

  const paths =
    `<path d="${chart.forecastPath}" fill="none" stroke="var(--series)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round" />
     <path d="${chart.actualPath}" fill="none" stroke="var(--series)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
     <path d="${chart.actualGapPath}" fill="none" stroke="var(--series)" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 7" />`;

  svg.innerHTML = `<desc id="fchart-desc">${t(lang, 'fchart.title')}</desc>${closedBands}${fcBand}${grid}${yLabels}${xLabels}${historicPaths}${nowMarker}${fcHigh}${paths}<g id="fchart-hover" style="pointer-events:none"></g>`;

  fchartState = { chart, points: curve.points, actual, nowMin, direction: fchartDirection };
  renderLeaveStrip();
  bindForecastChartHover(svg as unknown as SVGSVGElement);

  // Legend: the solid "measured" line only exists for today.
  const legendActual = document.getElementById('fchart-legend-actual');
  if (legendActual) legendActual.hidden = !(isToday && chart.actualPath !== '');
  const legendClosed = document.getElementById('fchart-legend-closed');
  if (legendClosed) legendClosed.hidden = chart.closedBands.length === 0;
  const legendGap = document.getElementById('fchart-legend-gap');
  if (legendGap) legendGap.hidden = chart.actualGapPath === '';

  const legendHistoric = document.getElementById('fchart-legend-historic');
  if (legendHistoric) {
    legendHistoric.innerHTML = chart.historic
      .map(h => `<span class="legend__item" style="color:${h.color}"><span class="swatch--line" style="border-top-width:2px"></span><span style="color:var(--md-on-surface-variant)">${isoDateLabel(h.isoDate)}</span></span>`)
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
    let peak = 0, peakMin = 0, peakHigh = 0;
    for (const p of curve.points) {
      const w = fchartDirection === 'north' ? p.northWait : p.southWait;
      const wh = fchartDirection === 'north' ? p.northWaitHigh : p.southWaitHigh;
      if (w > peak) { peak = w; peakMin = p.minuteOfDay; peakHigh = wh; }
    }
    const ctx = curve.context ? ` · ${curve.context}` : '';
    // Peak shown as a typical→busy range so a bad day doesn't look like a miss.
    const peakRange = peakHigh > peak + 1 ? `${peak}–${peakHigh}` : `${peak}`;
    subtitle.textContent = peak > 0
      ? (lang === 'de'
          ? `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Spitze ca. ${peakRange} Min (typisch–stark) gegen ${minuteToHHMM(peakMin)}`
          : `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Peak ~${peakRange} min (typical–busy) around ${minuteToHHMM(peakMin)}`)
      : (lang === 'de'
          ? `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Kaum Stau erwartet`
          : `${curve.fullDayLabel}, ${curve.dateLabel}${ctx} · Little congestion expected`);
  }
}

// ─── "When to leave?" strip ───────────────────────────────────────────────────

function renderLeaveStrip() {
  const cells = document.getElementById('leave-cells');
  const win = document.getElementById('leave-window');
  const wrap = document.getElementById('leave');
  if (!cells || !win || !wrap) return;
  const now = new Date();
  const from = new Date(now.getTime() + fchartDayOffset * 86_400_000);
  const day = generateForecast(from, lang, 1)[0];
  if (!day) return;
  const nowHour = fchartDayOffset === 0 ? Math.floor(swissDayInfo(now).minuteOfDay / 60) : -1;
  const levelKey = fchartDirection === 'north' ? 'northLevel' : 'southLevel';
  wrap.setAttribute('data-dir', fchartDirection);
  document.querySelectorAll('#leave [data-level-dir]').forEach((el) => el.setAttribute('data-level-dir', fchartDirection));
  cells.innerHTML = day.hours
    .map((h) => {
      const label = `${pad2(h.localHour)}:00 · ${LEVEL_LABEL[h[levelKey]][lang]}`;
      return `<div class="leave__cell" data-level="${h[levelKey]}"${h.localHour === nowHour ? ' data-now=""' : ''} title="${label}" aria-label="${label}" role="img"></div>`;
    })
    .join('');

  // Quiet window: before the first and after the last hour that isn't "low".
  const busy = day.hours.filter((h) => h[levelKey] !== 'low').map((h) => h.localHour);
  if (busy.length === 0) {
    win.textContent = lang === 'de' ? 'den ganzen Tag' : 'all day';
  } else {
    const first = busy[0];
    const last = busy[busy.length - 1] + 1;
    const parts: string[] = [];
    if (first > 0) parts.push(`${lang === 'de' ? 'vor' : 'before'} ${pad2(first)}:00`);
    if (last < 24) parts.push(`${lang === 'de' ? 'ab' : 'from'} ${pad2(last)}:00`);
    win.textContent = parts.length ? parts.join(lang === 'de' ? ' oder ' : ' or ') : (lang === 'de' ? 'kaum ruhige Stunden' : 'hardly any quiet hours');
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
    const predictedHigh = direction === 'north' ? fp.northWaitHigh : fp.southWaitHigh;

    const meas = nearestActual(actual, nowMin, fp.minuteOfDay, direction);

    // Hover guides: vertical line + predicted dot, measured dot, historic dots.
    const dot = (yMin: number, color: string, filled: boolean) =>
      `<circle cx="${px.toFixed(1)}" cy="${fchartYOf(yMin, chart).toFixed(1)}" r="3.5" fill="${filled ? color : 'var(--color-surface)'}" stroke="${color}" stroke-width="1.5" />`;
    g.innerHTML =
      `<line x1="${px.toFixed(1)}" y1="${chart.plot.top}" x2="${px.toFixed(1)}" y2="${chart.plot.bottom}" stroke="var(--md-outline)" stroke-width="1" stroke-dasharray="3 3" />` +
      dot(predicted, 'var(--series)', false) +
      (meas !== null ? dot(meas, 'var(--series)', true) : '') +
      chart.historic.map(h => dot(h.values[idx], h.color, true)).join('');

    // Tooltip: predicted always, measured (today) and historic values (if any) below.
    const dirLabel = direction === 'north' ? t(lang, 'dir.south') : t(lang, 'dir.north');
    const predWord = lang === 'de' ? 'Prognose' : 'Forecast';
    const measWord = lang === 'de' ? 'Gemessen' : 'Measured';
    const unit = lang === 'de' ? 'Min' : 'min';

    let sub = meas !== null ? `<div class="fchart__tt-sub">${measWord}: ${Math.round(meas)} ${unit}</div>` : '';
    sub += chart.historic
      .map(h => `<div class="fchart__tt-sub" style="color:${h.color}">${isoDateLabel(h.isoDate)}: ${Math.round(h.values[idx])} ${unit}</div>`)
      .join('');

    // Show the forecast as a typical→busy-day range (e.g. "45–120 min").
    const rangeText = predictedHigh > predicted + 1
      ? `${Math.round(predicted)}–${Math.round(predictedHigh)}`
      : `${Math.round(predicted)}`;
    const closedNow = actual.some(a => a.closed && Math.abs(a.minuteOfDay - fp.minuteOfDay) <= 7);
    if (closedNow) sub += `<div class="fchart__tt-sub">${lang === 'de' ? 'Tunnel gesperrt: keine Messung, Stau wächst weiter' : 'Tunnel closed: no reading, queue keeps growing'}</div>`;
    tip.innerHTML =
      `<div class="fchart__tt-time">${minuteToHHMM(fp.minuteOfDay)}</div>` +
      `<div class="fchart__tt-row"><span class="fchart__tt-key"><span class="fchart__tt-dot" style="background:var(--series)"></span>${dirLabel}</span>` +
        `<span class="fchart__tt-val">${predWord}: ${rangeText} ${unit}</span></div>` +
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

  lead.textContent = res.closed
    ? (lang === 'de'
        ? 'Gotthard-Strassentunnel gesperrt. Mögliche Ausweichrouten:'
        : 'Gotthard road tunnel closed. Possible alternative routes:')
    : (lang === 'de'
        ? `Aktuell ca. ${res.worstWait} Min Wartezeit (${res.directionLabel}). Mögliche Ausweichrouten:`
        : `Currently about ${res.worstWait} min wait (${res.directionLabel}). Possible alternative routes:`);

  const recLabel = lang === 'de' ? 'Schneller als warten' : 'Faster than waiting';
  const unit = lang === 'de' ? 'Min' : 'min';
  const scale = Math.max(120, res.worstWait, ...res.routes.map(r => r.extraMinutes));
  const bar = (cls: string, name: string, value: string, minutes: number, extra = '') => `<li class="diversion__row ${cls}">
      <div class="diversion__row-head"><span class="diversion__row-name">${name}</span><span>${value}</span></div>
      <div class="diversion__track" aria-hidden="true"><div class="diversion__fill" style="width:${((minutes / scale) * 100).toFixed(1)}%"></div></div>${extra}
    </li>`;

  const tunnelRow = res.closed
    ? bar('diversion__row--off', t(lang, 'diversion.tunnel'), t(lang, 'status.closed'), 0)
    : bar('diversion__row--tunnel', t(lang, 'diversion.tunnel'), `${res.worstWait} ${unit}`, res.worstWait);
  list.innerHTML = tunnelRow + res.routes.map(r => {
    const cls = `${r.recommended ? 'diversion__row--rec' : ''}${!r.available ? ' diversion__row--off' : ''}`;
    const badge = r.recommended ? `<span class="diversion__badge">${recLabel}</span>` : '';
    const note = r.note ? `<em class="diversion__note">${r.note}</em>` : `<em class="diversion__note">${r.description}</em>`;
    return bar(cls, `${r.name}${badge}`, `+${r.extraMinutes} ${unit}`, r.extraMinutes, note);
  }).join('');
}

// ─── Forecast rendering ───────────────────────────────────────────────────────

const LEVEL_LABEL: Record<TrafficLevel, Record<'de' | 'en', string>> = {
  low:      { de: 'Frei',           en: 'Clear' },
  moderate: { de: 'Mässig',         en: 'Moderate' },
  high:     { de: 'Stau erwartet',  en: 'Congestion' },
  extreme:  { de: 'Starker Stau',   en: 'Heavy jam' },
};

// 7-day outlook: expected peak wait per direction, as grouped bars.
const LEVEL_ORDER: TrafficLevel[] = ['low', 'moderate', 'high', 'extreme'];
const LEVEL_ICON = { low: 'check_circle', moderate: 'error', high: 'warning', extreme: 'block' } as const;

function renderWeek() {
  const container = document.getElementById('week-days');
  if (!container) return;
  const days = generateForecast(new Date(), lang, 7);
  const prefix = lang === 'de' ? '' : '/en';
  const peaks = days.map((d) => ({
    n: Math.max(...d.hours.map((h) => h.northIdx)),
    s: Math.max(...d.hours.map((h) => h.southIdx)),
    lv: LEVEL_ORDER[Math.max(...d.hours.map((h) => Math.max(LEVEL_ORDER.indexOf(h.northLevel), LEVEL_ORDER.indexOf(h.southLevel))))],
  }));
  const maxWait = Math.max(30, ...peaks.map((p) => idxToWaitMinutes(Math.max(p.n, p.s))));
  const bar = (dir: 'north' | 'south', idx: number) => {
    const min = idxToWaitMinutes(idx);
    const h = Math.max(2, Math.round((min / maxWait) * 96));
    return `<div class="week__bar week__bar--${dir}"><span>${min}</span><i style="height:${h}px"></i></div>`;
  };
  container.innerHTML = days
    .map((d, i) => {
      const p = peaks[i];
      const name = i === 0 ? (lang === 'de' ? 'Heute' : 'Today') : d.dayLabel;
      const unit = lang === 'de' ? 'Min' : 'min';
      const aria = `${d.fullDayLabel} ${d.dateLabel}: ${t(lang, 'dir.south')} ${idxToWaitMinutes(p.n)} ${unit}, ${t(lang, 'dir.north')} ${idxToWaitMinutes(p.s)} ${unit} · ${LEVEL_LABEL[p.lv][lang]}`;
      return `<a class="week__day" href="${prefix}/forecasts" aria-label="${escapeHtml(aria)}"${i === 0 ? ' data-today=""' : ''}>
        <span class="week__name">${name}</span>
        <span class="week__date">${d.dateLabel}</span>
        <div class="week__bars" aria-hidden="true">${bar('north', p.n)}${bar('south', p.s)}</div>
        <span class="week__level">${iconSvg(LEVEL_ICON[p.lv], 16, `icon lvl-icon--${p.lv}`)}${LEVEL_LABEL[p.lv][lang]}</span>
        ${d.context ? `<span class="week__ctx">${escapeHtml(d.context)}</span>` : ''}
      </a>`;
    })
    .join('');
}

function renderHeroContext() {
  const today = generateForecast(new Date(), lang, 1)[0];
  const chip = document.getElementById('hero-context');
  if (!chip) return;
  if (today?.context) {
    setText('hero-context-label', today.context);
    chip.removeAttribute('hidden');
  } else {
    chip.setAttribute('hidden', '');
  }
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
  lastHistoryLoaded = history !== null;
  renderForecastChart(lastHistory);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

let lastHistoryLoaded = false;
let resizeTimer: number | undefined;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // ignore mobile URL-bar height changes
  lastWidth = window.innerWidth;
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (lastHistoryLoaded) renderHistory(lastHistory);
    renderForecastChart(lastHistory);
  }, 150);
});

tick();
setInterval(tick, POLL_INTERVAL_MS);

// Week outlook + holiday context are calendar-based — render once on load
renderWeek();
renderHeroContext();
// Day tabs + portal toggle are calendar-based too — set up once, no polling needed
renderDayTabs(new Date());
bindDayNav();
bindPortalToggle();
// Render the prediction curve immediately so the chart isn't empty before the first fetch
renderForecastChart([]);
