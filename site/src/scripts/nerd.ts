import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { generateForecast, idxToWaitMinutes } from '../lib/forecast';

interface Stats {
  heatmap: { north: (number | null)[][]; south: (number | null)[][] };
  records: {
    longestQueue: { km: number; portal: string; at: string } | null;
    longestWait: { minutes: number; portal: string; at: string } | null;
    worstDay: { date: string; waitSum: number } | null;
    longestJamFree: { hours: number; from: string; to: string } | null;
  };
  asymmetry: { month: string; north: number | null; south: number | null }[];
  minutesPerKm: { north: number | null; south: number | null };
  closures: { reason: string; count: number; hours: number }[];
  jamDynamics: { buildUpKmPerHour: number | null; dissolveKmPerHour: number | null };
  dataQuality: { snapshots: number; first: string | null; last: string | null; gaps: number };
  last7d: { t: string; north: number | null; south: number | null }[];
}

const lang = (() => {
  const attr = document.documentElement.dataset.lang;
  return isLang(attr) ? attr : DEFAULT_LANG;
})();
const locale = lang === 'de' ? 'de-CH' : 'en-GB';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const num = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined ? '–' : v.toLocaleString(locale, { maximumFractionDigits: digits });
const dt = (iso: string) =>
  new Date(iso).toLocaleString(locale, { timeZone: 'Europe/Zurich', dateStyle: 'medium', timeStyle: 'short' });
const portalName = (p: string) => t(lang, p === 'north' ? 'nerd.north' : 'nerd.south');
const row = (label: string, value: string) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as T & { error?: string };
    return data && !data.error ? data : null;
  } catch {
    return null;
  }
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderHeatmap(id: string, grid: (number | null)[][]) {
  const days = t(lang, 'nerd.days').split(',');
  const max = Math.max(1, ...grid.flat().map((v) => v ?? 0));
  let html = '<table class="nerd-heat"><thead><tr><th></th>';
  for (let h = 0; h < 24; h++) html += `<th>${h}</th>`;
  html += '</tr></thead><tbody>';
  grid.forEach((hours, d) => {
    html += `<tr><th>${esc(days[d] ?? '')}</th>`;
    hours.forEach((v, h) => {
      const a = v === null ? 0 : Math.min(1, v / max);
      html += `<td style="--a:${a.toFixed(2)}" title="${esc(days[d] ?? '')} ${h}:00 – ${num(v)} ${t(lang, 'nerd.min')}"></td>`;
    });
    html += '</tr>';
  });
  $(id).innerHTML = html + '</tbody></table>';
}

function renderRecords(r: Stats['records']) {
  const parts: string[] = [];
  if (r.longestQueue)
    parts.push(row(t(lang, 'nerd.records.queue'), `${num(r.longestQueue.km)} km · ${esc(portalName(r.longestQueue.portal))}<br><small>${esc(dt(r.longestQueue.at))}</small>`));
  if (r.longestWait)
    parts.push(row(t(lang, 'nerd.records.wait'), `${num(r.longestWait.minutes, 0)} ${t(lang, 'nerd.min')} · ${esc(portalName(r.longestWait.portal))}<br><small>${esc(dt(r.longestWait.at))}</small>`));
  if (r.worstDay)
    parts.push(row(t(lang, 'nerd.records.worstDay'), `${esc(r.worstDay.date)} · ${num(r.worstDay.waitSum, 0)}`));
  if (r.longestJamFree)
    parts.push(row(t(lang, 'nerd.records.jamFree'), `${num(r.longestJamFree.hours)} h<br><small>${esc(dt(r.longestJamFree.from))}</small>`));
  $('nerd-records').innerHTML = parts.join('');
}

function renderAsymmetry(rows: Stats['asymmetry']) {
  const W = 420, H = 180, L = 28, B = 22, T = 8;
  const max = Math.max(1, ...rows.flatMap((r) => [r.north ?? 0, r.south ?? 0]));
  const slot = (W - L) / Math.max(rows.length, 1);
  const bw = Math.min(22, slot / 2.4);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t(lang, 'nerd.asym.title'))}" class="nerd-svg">`;
  svg += `<line x1="${L}" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="var(--color-border)"/>`;
  svg += `<text x="${L - 4}" y="${T + 8}" text-anchor="end" class="nerd-svg__t">${num(max, 0)}</text>`;
  rows.forEach((r, i) => {
    const cx = L + slot * i + slot / 2;
    const n = r.north ?? 0;
    const s = r.south ?? 0;
    svg += `<rect x="${cx - bw}" y="${y(n)}" width="${bw}" height="${y(0) - y(n)}" fill="var(--c-north)"><title>${esc(t(lang, 'nerd.north'))}: ${num(r.north)}</title></rect>`;
    svg += `<rect x="${cx}" y="${y(s)}" width="${bw}" height="${y(0) - y(s)}" fill="var(--c-south)"><title>${esc(t(lang, 'nerd.south'))}: ${num(r.south)}</title></rect>`;
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle" class="nerd-svg__t">${esc(r.month.slice(2))}</text>`;
  });
  $('nerd-asym').innerHTML =
    svg + '</svg><p class="nerd-legend"><span style="--c:var(--c-north)">' + esc(t(lang, 'nerd.north')) +
    '</span><span style="--c:var(--c-south)">' + esc(t(lang, 'nerd.south')) + '</span></p>';
}

function renderClosures(rows: Stats['closures']) {
  if (rows.length === 0) {
    $('nerd-closures').innerHTML = `<p class="nerd-card__sub">${esc(t(lang, 'nerd.closures.none'))}</p>`;
    return;
  }
  $('nerd-closures').innerHTML =
    `<table class="nerd-table"><thead><tr><th>${esc(t(lang, 'nerd.closures.reason'))}</th><th>${esc(t(lang, 'nerd.closures.count'))}</th><th>${esc(t(lang, 'nerd.closures.hours'))}</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.reason)}</td><td>${r.count}</td><td>${num(r.hours)}</td></tr>`).join('') +
    '</tbody></table>';
}

/** Forecast vs reality (south portal chart, MAE for both portals). */
function renderForecastVsReality(last7d: Stats['last7d']) {
  const host = $('nerd-fvr');
  if (last7d.length === 0) {
    host.innerHTML = `<p class="nerd-card__sub">${esc(t(lang, 'nerd.fvr.empty'))}</p>`;
    $('nerd-mae').innerHTML = '';
    return;
  }
  const start = new Date(Date.now() - 6 * 86_400_000);
  const days = generateForecast(start, lang, 7);
  // Forecast per hour, keyed by Swiss-local "YYYY-MM-DD H".
  const fc = new Map<string, { n: number; s: number }>();
  for (const day of days)
    for (const h of day.hours)
      fc.set(`${day.isoDate} ${h.localHour}`, { n: idxToWaitMinutes(h.northIdx, 10), s: idxToWaitMinutes(h.southIdx, 10) });
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const key = (iso: string) => {
    const [d, h] = fmt.format(new Date(iso)).split(' '); // "2026-08-03 12"
    return `${d} ${Number(h)}`;
  };

  const pts = last7d.map((p) => ({ ms: new Date(p.t).getTime(), real: p, f: fc.get(key(p.t)) }));
  const err = { north: [] as number[], south: [] as number[] };
  for (const p of pts) {
    if (!p.f) continue;
    if (p.real.north !== null) err.north.push(Math.abs(p.real.north - p.f.n));
    if (p.real.south !== null) err.south.push(Math.abs(p.real.south - p.f.s));
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const W = 720, H = 200, L = 34, B = 20, T = 8;
  const t0 = pts[0].ms;
  const t1 = pts[pts.length - 1].ms;
  const max = Math.max(10, ...pts.map((p) => Math.max(p.real.south ?? 0, p.f?.s ?? 0)));
  const x = (ms: number) => L + ((W - L - 4) * (ms - t0)) / Math.max(1, t1 - t0);
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const path = (get: (p: (typeof pts)[number]) => number | null | undefined) => {
    let d = '';
    let pen = false;
    for (const p of pts) {
      const v = get(p);
      if (v === null || v === undefined) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.ms).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    }
    return d;
  };
  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="nerd-svg" role="img" aria-label="${esc(t(lang, 'nerd.fvr.title'))}">` +
    `<line x1="${L}" y1="${y(0)}" x2="${W}" y2="${y(0)}" stroke="var(--color-border)"/>` +
    `<text x="${L - 4}" y="${T + 8}" text-anchor="end" class="nerd-svg__t">${num(max, 0)}</text>` +
    `<path d="${path((p) => p.f?.s)}" fill="none" stroke="var(--color-text-muted)" stroke-width="2" stroke-dasharray="6 4"/>` +
    `<path d="${path((p) => p.real.south)}" fill="none" stroke="var(--c-south)" stroke-width="2.5" stroke-linejoin="round"/>` +
    '</svg>';
  $('nerd-mae').innerHTML =
    row(`${t(lang, 'nerd.north')} – ${t(lang, 'nerd.fvr.mae')}`, num(mean(err.north))) +
    row(`${t(lang, 'nerd.south')} – ${t(lang, 'nerd.fvr.mae')}`, num(mean(err.south)));
}

function downloadCsv(s: Stats) {
  const lines = ['section,portal,weekday,hour,value'];
  (['north', 'south'] as const).forEach((portal) =>
    s.heatmap[portal].forEach((hours, d) => hours.forEach((v, h) => lines.push(`heatmap,${portal},${d},${h},${v ?? ''}`)))
  );
  lines.push('', 'section,hour_utc,north_wait_min,south_wait_min');
  s.last7d.forEach((p) => lines.push(`last7d,${p.t},${p.north ?? ''},${p.south ?? ''}`));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gotthard-stats.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Fun API: next train Göschenen → Airolo (transport.opendata.ch, no key) ──

async function renderTrain() {
  try {
    const res = await fetch('https://transport.opendata.ch/v1/connections?from=G%C3%B6schenen&to=Airolo&limit=1');
    if (!res.ok) return;
    const c = (await res.json()).connections?.[0];
    if (!c?.from?.departure) return;
    const live = await fetchJson<{ tunnel?: { north?: { waitMinutes: number | null } } }>('/api/gotthard.php');
    const wait = live?.tunnel?.north?.waitMinutes ?? null;
    const dur = String(c.duration ?? '').replace(/^\d+d/, '').split(':');
    const time = new Date(c.from.departure).toLocaleTimeString(locale, { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
    $('nerd-train-body').innerHTML =
      row(t(lang, 'nerd.train.departs'), esc(time)) +
      row(t(lang, 'nerd.train.duration'), dur.length >= 2 ? `${Number(dur[0]) * 60 + Number(dur[1])} ${t(lang, 'nerd.min')}` : '–') +
      row(t(lang, 'nerd.train.wait'), wait === null ? '–' : `${wait} ${t(lang, 'nerd.min')}`);
    $('nerd-train').hidden = false;
  } catch {
    /* hide the card silently */
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  const s = (await fetchJson<Stats>('/api/stats.php')) ?? (await fetchJson<Stats>('/data/stats.json'));
  if (!s) {
    $('nerd-empty').hidden = false;
    return;
  }
  renderHeatmap('nerd-heat-north', s.heatmap.north);
  renderHeatmap('nerd-heat-south', s.heatmap.south);
  renderRecords(s.records);
  renderAsymmetry(s.asymmetry);
  $('nerd-mpk').innerHTML =
    row(t(lang, 'nerd.north'), `${num(s.minutesPerKm.north)} ${t(lang, 'nerd.min')}/km`) +
    row(t(lang, 'nerd.south'), `${num(s.minutesPerKm.south)} ${t(lang, 'nerd.min')}/km`);
  $('nerd-dyn').innerHTML =
    row(t(lang, 'nerd.dyn.up'), num(s.jamDynamics.buildUpKmPerHour)) +
    row(t(lang, 'nerd.dyn.down'), num(s.jamDynamics.dissolveKmPerHour));
  renderClosures(s.closures);
  const q = s.dataQuality;
  $('nerd-quality').innerHTML =
    row(t(lang, 'nerd.quality.snapshots'), num(q.snapshots, 0)) +
    row(t(lang, 'nerd.quality.range'), q.first && q.last ? `${esc(dt(q.first))} – ${esc(dt(q.last))}` : '–') +
    row(t(lang, 'nerd.quality.gaps'), num(q.gaps, 0));
  renderForecastVsReality(s.last7d);
  $('nerd-csv').addEventListener('click', () => downloadCsv(s));
  $('nerd-body').hidden = false;
  void renderTrain();
}

void main();
