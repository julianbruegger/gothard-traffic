// Forecast page: day profile small multiples (linked hover) and a month
// calendar of expected peak congestion. Everything here is calendar-based —
// computed in the browser so it is always relative to "today".
import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { generateDayCurve, generateForecast, swissDayInfo, type DayCurve, type TrafficLevel } from '../lib/forecast';
import { iconSvg } from '../lib/icons';
import { OBSERVED_UPDATED_EVENT } from '../lib/observed-live';

const lang = (() => {
  const attr = document.documentElement.dataset.lang;
  return isLang(attr) ? attr : DEFAULT_LANG;
})();
const L = (de: string, en: string) => (lang === 'de' ? de : en);
const pad2 = (n: number) => String(n).padStart(2, '0');
const hhmm = (m: number) => `${pad2(Math.floor(m / 60) % 24)}:${pad2(m % 60)}`;
const unit = L('Min', 'min');
type Dir = 'north' | 'south';

// ─── Day profile ──────────────────────────────────────────────────────────────

let W = 560, H = 250, PR = 548, PB = 212;
const PL = 44, PT = 16;
let dayOffset = 0;
let curve: DayCurve | null = null;
let maxMin = 60;

const xOf = (m: number) => PL + ((PR - PL) * m) / 1440;
const yOf = (v: number) => PB - (Math.min(v, maxMin) / maxMin) * (PB - PT);

function renderDayChips() {
  const el = document.getElementById('dp-days');
  if (!el) return;
  const now = new Date();
  el.innerHTML = Array.from({ length: 7 }, (_, i) => {
    const d = generateForecast(new Date(now.getTime() + i * 86_400_000), lang, 1)[0];
    const label = i === 0 ? L('Heute', 'Today') : `${d.dayLabel} ${d.dateLabel}`;
    return `<button type="button" class="filter-chip" data-offset="${i}" aria-pressed="${i === dayOffset}">${iconSvg('check', 18, 'icon seg__check')}${label}</button>`;
  }).join('');
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button[data-offset]') as HTMLButtonElement | null;
    if (!btn) return;
    dayOffset = Number(btn.dataset.offset);
    el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.offset) === dayOffset)));
    renderProfiles();
  });
}

function drawPanel(dir: Dir) {
  const svg = document.getElementById(`dp-${dir}`);
  if (!svg || !curve) return;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const key = dir === 'north' ? 'northWait' : 'southWait';
  const hiKey = dir === 'north' ? 'northWaitHigh' : 'southWaitHigh';
  const pts = curve.points;
  const P = (m: number, v: number) => `${xOf(m).toFixed(1)},${yOf(v).toFixed(1)}`;
  const line = 'M' + pts.map((p) => P(p.minuteOfDay, p[key])).join(' L');
  const band = 'M' + pts.map((p) => P(p.minuteOfDay, p[hiKey])).join(' L') + ' L' +
    pts.slice().reverse().map((p) => P(p.minuteOfDay, p[key])).join(' L') + ' Z';

  const grid = [0, 1, 2, 3, 4].map((i) => {
    const v = (maxMin / 4) * i;
    const y = yOf(v).toFixed(1);
    return `<line x1="${PL}" x2="${PR}" y1="${y}" y2="${y}" stroke="${i === 0 ? 'var(--md-outline)' : 'var(--md-outline-variant)'}" stroke-width="1" />` +
      `<text x="${PL - 6}" y="${+y + 4}" text-anchor="end" font-size="12" fill="var(--md-on-surface-variant)">${Math.round(v)}${i === 4 ? ` ${unit}` : ''}</text>`;
  }).join('');
  const xt = [0, 6, 12, 18, 24].map((h) =>
    `<text x="${xOf(h * 60).toFixed(1)}" y="${PB + 24}" text-anchor="middle" font-size="12" fill="var(--md-on-surface-variant)">${pad2(h)}:00</text>`).join('');

  let peak = pts[0];
  for (const p of pts) if (p[key] > peak[key]) peak = p;
  const px = xOf(peak.minuteOfDay), py = yOf(peak[key]);

  svg.innerHTML = `${grid}${xt}
    <path d="${band}" fill="var(--c-${dir}-tint)" />
    <path d="${line}" fill="none" stroke="var(--c-${dir})" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
    ${peak[key] > 0 ? `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="var(--c-${dir})" stroke="var(--md-sc-lowest)" stroke-width="2" />` : ''}
    <g class="dp-hover" style="pointer-events:none"></g>`;

  const label = document.getElementById(`dp-${dir}-peak`);
  if (label) {
    if (peak[key] > 0) {
      label.textContent = `${L('Spitze', 'Peak')} ${hhmm(peak.minuteOfDay)} · ${peak[key]} ${unit}`;
      label.style.left = `${((px / W) * 100).toFixed(2)}%`;
      label.style.top = `${(((py - 28) / H) * 100).toFixed(2)}%`;
      label.style.transform = `translateX(${peak.minuteOfDay > 1200 ? '-100%' : peak.minuteOfDay < 180 ? '0' : '-50%'})`;
      label.hidden = false;
    } else {
      label.hidden = true;
    }
  }
  svg.setAttribute('aria-label', `${t(lang, dir === 'north' ? 'dir.south' : 'dir.north')}, ${curve.fullDayLabel} ${curve.dateLabel}: ${
    peak[key] > 0 ? `${L('Spitze', 'peak')} ${peak[key]} ${unit} ${L('um', 'at')} ${hhmm(peak.minuteOfDay)}` : L('kaum Stau erwartet', 'little congestion expected')}`);
}

function setReadout(minute: number | null) {
  if (!curve) return;
  const m = minute ?? 12 * 60;
  const p = curve.points[Math.round(m / 10)];
  const fmt = (v: number, hi: number) => (hi > v + 1 ? `${v}–${hi} ${unit}` : `${v} ${unit}`);
  document.getElementById('dp-time')!.textContent = minute === null ? `${L('Mittag', 'Noon')} · 12:00` : hhmm(p.minuteOfDay);
  document.getElementById('dp-north-val')!.textContent = fmt(p.northWait, p.northWaitHigh);
  document.getElementById('dp-south-val')!.textContent = fmt(p.southWait, p.southWaitHigh);
  document.querySelectorAll<SVGGElement>('.dp-hover').forEach((g) => {
    g.innerHTML = minute === null ? '' :
      `<line x1="${xOf(p.minuteOfDay).toFixed(1)}" x2="${xOf(p.minuteOfDay).toFixed(1)}" y1="${PT}" y2="${PB}" stroke="var(--md-outline)" stroke-dasharray="3 3" />`;
  });
}

function bindHover() {
  for (const dir of ['north', 'south'] as Dir[]) {
    const svg = document.getElementById(`dp-${dir}`);
    if (!svg) continue;
    svg.style.touchAction = 'pan-y';
    svg.addEventListener('pointermove', (e) => {
      const r = svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const m = Math.max(0, Math.min(1440, ((x - PL) / (PR - PL)) * 1440));
      setReadout(Math.round(m / 10) * 10);
    });
    svg.addEventListener('pointerleave', () => setReadout(null));
  }
}

function measure() {
  const w = document.getElementById('dp-north-wrap')?.clientWidth ?? 0;
  W = w > 0 ? Math.round(Math.max(300, Math.min(800, w))) : 560;
  H = W < 480 ? 220 : 250;
  PR = W - 12;
  PB = H - 38;
}

/** Typical peak below this (minutes, both directions) counts as "no relevant queue". */
const QUIET_PEAK_MIN = 5;

function renderProfiles() {
  curve = generateDayCurve(new Date(Date.now() + dayOffset * 86_400_000), lang);
  const typical = Math.max(...curve.points.map((p) => Math.max(p.northWait, p.southWait)));
  const quiet = typical < QUIET_PEAK_MIN;
  // Off-season days: a plain statement instead of two empty charts.
  document.getElementById('dp-quiet')!.hidden = !quiet;
  document.getElementById('dp-panels')!.style.display = quiet ? 'none' : '';
  document.getElementById('dp-legend')!.style.display = quiet ? 'none' : '';
  if (!quiet) {
    measure();
    const peak = Math.max(...curve.points.map((p) => Math.max(p.northWaitHigh, p.southWaitHigh)));
    // At least 20 min (4 even ticks) so a small queue is still readable.
    maxMin = peak * 1.05 <= 20 ? 20 : peak * 1.05 <= 40 ? 40 : Math.max(60, Math.ceil((peak * 1.05) / 30) * 30);
    drawPanel('north');
    drawPanel('south');
  }
  document.getElementById('dp-ctx')!.textContent = `${curve.fullDayLabel}, ${curve.dateLabel}${curve.context ? ` · ${curve.context}` : ''}`;
  setReadout(null);
}

// ─── Calendar ────────────────────────────────────────────────────────────────

const LEVELS: TrafficLevel[] = ['low', 'moderate', 'high', 'extreme'];
const LEVEL_TEXT: Record<TrafficLevel, string> = {
  low: t(lang, 'forecast.low'), moderate: t(lang, 'forecast.moderate'),
  high: t(lang, 'forecast.high'), extreme: t(lang, 'forecast.extreme'),
};
let calDir: Dir = 'north';
let calStart = 0; // months from the current month
const monthFmt = new Intl.DateTimeFormat(lang === 'de' ? 'de-CH' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dowHead = lang === 'de' ? ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function renderCalendar() {
  const el = document.getElementById('cal-months');
  const section = document.getElementById('calendar');
  if (!el || !section) return;
  section.setAttribute('data-dir', calDir);
  document.querySelectorAll('#calendar .legend [data-level-dir]').forEach((s) => s.setAttribute('data-level-dir', calDir));
  const today = swissDayInfo(new Date()).isoDate;
  const [ty, tm] = today.split('-').map(Number);
  const levelKey = calDir === 'north' ? 'northLevel' : 'southLevel';
  const idxKey = calDir === 'north' ? 'northIdx' : 'southIdx';
  const names: string[] = [];

  el.innerHTML = Array.from({ length: 4 }, (_, k) => {
    const first = new Date(Date.UTC(ty, tm - 1 + calStart + k, 1, 10));
    const y = first.getUTCFullYear(), mo = first.getUTCMonth();
    const days = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const offset = (first.getUTCDay() + 6) % 7;
    const name = monthFmt.format(first);
    names.push(name);
    const forecast = generateForecast(first, lang, days);
    const cells = forecast.map((d, i) => {
      const lv = LEVELS[Math.max(...d.hours.map((h) => LEVELS.indexOf(h[levelKey])))];
      const peak = Math.max(...d.hours.map((h) => h[idxKey]));
      const title = `${d.fullDayLabel} ${d.dateLabel}: ${LEVEL_TEXT[lv]} · ${L('Spitze', 'peak')} ${peak.toFixed(1)} km${d.context ? ` · ${d.context}` : ''}`;
      return `<div class="cal-day" data-level="${lv}"${d.isoDate === today ? ' data-today=""' : ''}${d.context ? ' data-holiday=""' : ''} title="${title}" aria-label="${title}" role="img">${i + 1}<i></i></div>`;
    }).join('');
    return `<div class="cal-month"><h3>${name}</h3><div class="cal-grid">${dowHead.map((d) => `<span class="cal-dow" aria-hidden="true">${d}</span>`).join('')}${'<span></span>'.repeat(offset)}${cells}</div></div>`;
  }).join('');
  document.getElementById('cal-range')!.textContent = `${names[0]} – ${names[3]}`;
  // Colour the cells by direction through the same ramp tokens as the legend.
  el.querySelectorAll<HTMLElement>('.cal-day').forEach((c) => c.setAttribute('data-level-dir', calDir));
}

function bindCalendar() {
  const set = (dir: Dir) => {
    calDir = dir;
    document.getElementById('cal-north')?.setAttribute('aria-pressed', String(dir === 'north'));
    document.getElementById('cal-south')?.setAttribute('aria-pressed', String(dir === 'south'));
    renderCalendar();
  };
  document.getElementById('cal-north')?.addEventListener('click', () => set('north'));
  document.getElementById('cal-south')?.addEventListener('click', () => set('south'));
  document.getElementById('cal-prev')?.addEventListener('click', () => { calStart -= 1; renderCalendar(); });
  document.getElementById('cal-next')?.addEventListener('click', () => { calStart += 1; renderCalendar(); });
}

let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastW) return;
  lastW = window.innerWidth;
  renderProfiles();
});

// The measured model is refitted on fresh data after load: redraw with it.
window.addEventListener(OBSERVED_UPDATED_EVENT, () => { renderProfiles(); renderCalendar(); });

renderDayChips();
bindHover();
renderProfiles();
bindCalendar();
renderCalendar();
