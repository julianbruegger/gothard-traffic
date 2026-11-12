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
  closures: { reason: string; key?: string; count: number; hours: number }[];
  jamDynamics: { buildUpKmPerHour: number | null; dissolveKmPerHour: number | null };
  dataQuality: { snapshots: number; first: string | null; last: string | null; gaps: number };
  last7d: { t: string; north: number | null; south: number | null }[];
  correlations?: {
    northSouth: { sameHour: number | null; best: { lagHours: number; r: number } | null };
    weather: { portal: string; hours: number; r: { temperature: number | null; precipitation: number | null; snowfall: number | null }; wetAvg: number | null; dryAvg: number | null; wetHours: number }[];
    weekend: Record<string, { weekday: number | null; weekend: number | null; ratio: number | null }>;
    afterClosure: { events: number } & Record<string, unknown>;
  };
  hourly30d?: { t: string; north: number | null; south: number | null }[];
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

const REASON_LABELS: Record<string, { de: string; en: string }> = {
  roadworks: { de: 'Bauarbeiten', en: 'Roadworks' },
  special_transport: { de: 'Sondertransport', en: 'Special transport' },
  breakdown: { de: 'Pannenfahrzeug', en: 'Broken-down vehicle' },
  accident: { de: 'Unfall', en: 'Accident' },
  fire: { de: 'Brand', en: 'Fire' },
  unknown: { de: 'Unbekannt', en: 'Unknown' },
};

function reasonLabel(r: { reason: string; key?: string }): string {
  const hit = r.key ? REASON_LABELS[r.key] : undefined;
  return hit ? hit[lang] : r.reason;
}

function renderClosures(rows: Stats['closures']) {
  if (rows.length === 0) {
    $('nerd-closures').innerHTML = `<p class="nerd-card__sub">${esc(t(lang, 'nerd.closures.none'))}</p>`;
    return;
  }
  $('nerd-closures').innerHTML =
    `<table class="nerd-table"><thead><tr><th>${esc(t(lang, 'nerd.closures.reason'))}</th><th>${esc(t(lang, 'nerd.closures.count'))}</th><th>${esc(t(lang, 'nerd.closures.hours'))}</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(reasonLabel(r))}</td><td>${r.count}</td><td>${num(r.hours)}</td></tr>`).join('') +
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


// ─── Fun API: weather (Open-Meteo, no key) ───────────────────────────────────

type Hourly = Stats['last7d'];
interface WeatherHour { temp: number | null; precip: number | null; snow: number | null }

const PORTALS = {
  north: { lat: 46.668, lon: 8.589 }, // Göschenen
  south: { lat: 46.529, lon: 8.608 }, // Airolo
} as const;

/** Hourly weather keyed by "YYYY-MM-DDTHH" (UTC), plus the current conditions. */
async function fetchWeather(portal: 'north' | 'south') {
  const { lat, lon } = PORTALS[portal];
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    '&current=temperature_2m,precipitation,snowfall&hourly=temperature_2m,precipitation,snowfall' +
    '&past_days=30&forecast_days=1&timezone=UTC';
  const res = await fetch(url);
  if (!res.ok) throw new Error('weather');
  const j = await res.json();
  const hours = new Map<string, WeatherHour>();
  (j.hourly.time as string[]).forEach((tm, i) =>
    hours.set(tm.slice(0, 13), { temp: j.hourly.temperature_2m[i], precip: j.hourly.precipitation[i], snow: j.hourly.snowfall[i] })
  );
  return { now: j.current as { temperature_2m: number; precipitation: number; snowfall: number }, hours };
}

/** Pearson r after removing each UTC hour-of-day's mean from both series. */
function deseasonedCorrelation(pairs: { h: number; x: number; y: number }[]): number | null {
  if (pairs.length < 24) return null;
  const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length;
  const byHour = new Map<number, { x: number[]; y: number[] }>();
  for (const p of pairs) {
    const e = byHour.get(p.h) ?? { x: [], y: [] };
    e.x.push(p.x);
    e.y.push(p.y);
    byHour.set(p.h, e);
  }
  const means = new Map<number, [number, number]>();
  byHour.forEach((e, h) => means.set(h, [mean(e.x), mean(e.y)]));
  const dx = pairs.map((p) => p.x - means.get(p.h)![0]);
  const dy = pairs.map((p) => p.y - means.get(p.h)![1]);
  const sxy = dx.reduce((a, v, i) => a + v * dy[i], 0);
  const sxx = dx.reduce((a, v) => a + v * v, 0);
  const syy = dy.reduce((a, v) => a + v * v, 0);
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function describeR(r: number | null): string {
  if (r === null) return '–';
  const a = Math.abs(r);
  const strength = a < 0.1 ? 'none' : a < 0.3 ? 'weak' : a < 0.5 ? 'moderate' : 'strong';
  const label = t(lang, `nerd.weather.r.${strength}` as 'nerd.weather.r.none');
  return strength === 'none' ? label : `${label} (${r > 0 ? t(lang, 'nerd.weather.pos') : t(lang, 'nerd.weather.neg')})`;
}

async function renderWeather(hourly: Hourly) {
  try {
    const [north, south] = await Promise.all([fetchWeather('north'), fetchWeather('south')]);
    const nowText = (w: typeof north) =>
      `${num(w.now.temperature_2m)} °C · ${t(lang, 'nerd.weather.rain')} ${num(w.now.precipitation)} mm · ${t(lang, 'nerd.weather.snow')} ${num(w.now.snowfall)} cm`;
    $('nerd-weather-now').className = 'nerd-dl';
    $('nerd-weather-now').innerHTML =
      row(`${t(lang, 'nerd.north')} – ${t(lang, 'nerd.weather.now')}`, esc(nowText(north))) +
      row(`${t(lang, 'nerd.south')} – ${t(lang, 'nerd.weather.now')}`, esc(nowText(south)));

    let body = '';
    if (hourly.length >= 24) {
      const vars: { label: string; get: (w: WeatherHour) => number | null }[] = [
        { label: t(lang, 'nerd.weather.temp'), get: (w) => w.temp },
        { label: t(lang, 'nerd.weather.rain'), get: (w) => w.precip },
        { label: t(lang, 'nerd.weather.snow'), get: (w) => w.snow },
      ];
      let rows = '';
      for (const [portal, w] of [['north', north], ['south', south]] as const) {
        for (const v of vars) {
          const pairs: { h: number; x: number; y: number }[] = [];
          for (const p of hourly) {
            const wait = p[portal];
            const wh = w.hours.get(p.t.slice(0, 13));
            const x = wh ? v.get(wh) : null;
            if (wait !== null && x !== null && x !== undefined) pairs.push({ h: new Date(p.t).getUTCHours(), x, y: wait });
          }
          const r = deseasonedCorrelation(pairs);
          rows += `<tr><td>${esc(portalName(portal))}</td><td>${esc(v.label)}</td><td>${r === null ? '–' : num(r, 2)}</td><td>${esc(describeR(r))}</td><td>${pairs.length}</td></tr>`;
        }
        let wet = 0, wetN = 0, dry = 0, dryN = 0;
        for (const p of hourly) {
          const wait = p[portal];
          const wh = w.hours.get(p.t.slice(0, 13));
          if (wait === null || !wh || wh.precip === null) continue;
          if (wh.precip > 0.1) { wet += wait; wetN++; } else { dry += wait; dryN++; }
        }
        rows += `<tr><td>${esc(portalName(portal))}</td><td colspan="2">${esc(t(lang, 'nerd.weather.wetVsDry'))}</td><td colspan="2">${wetN ? num(wet / wetN) : '–'} ${t(lang, 'nerd.min')} (${wetN}) vs ${dryN ? num(dry / dryN) : '–'} ${t(lang, 'nerd.min')} (${dryN})</td></tr>`;
      }
      body = `<div class="nerd-scroll"><table class="nerd-table"><thead><tr><th></th><th></th><th>r</th><th>${esc(t(lang, 'nerd.weather.corr'))}</th><th>${esc(t(lang, 'nerd.weather.samples'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    } else {
      body = `<p class="nerd-card__sub">${esc(t(lang, 'nerd.weather.insufficient'))}</p>`;
    }
    $('nerd-weather-corr').innerHTML = body;
    $('nerd-weather').hidden = false;
  } catch {
    /* hide the card silently */
  }
}

// ─── Fun API: school holidays (OpenHolidays, no key) ─────────────────────────

const HOLIDAY_COUNTRIES = [
  { code: 'CH', color: '#e53935' },
  { code: 'DE', color: '#fb8c00' },
  { code: 'NL', color: '#1e88e5' },
] as const;

async function renderHolidays(hourly: Hourly) {
  try {
    if (hourly.length === 0) return;
    const zDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Zurich' });
    const perDay = new Map<string, { sum: number; n: number }>();
    for (const p of hourly) {
      const v = [p.north, p.south].filter((x): x is number => x !== null);
      if (v.length === 0) continue;
      const d = zDay.format(new Date(p.t));
      const e = perDay.get(d) ?? { sum: 0, n: 0 };
      e.sum += v.reduce((a, b) => a + b, 0) / v.length;
      e.n++;
      perDay.set(d, e);
    }
    const days = [...perDay.keys()].sort();
    if (days.length < 2) return;
    const from = days[0];
    const to = days[days.length - 1];

    const lists = await Promise.all(
      HOLIDAY_COUNTRIES.map(async (c) => {
        const res = await fetch(`https://openholidaysapi.org/SchoolHolidays?countryIsoCode=${c.code}&languageIsoCode=EN&validFrom=${from}&validTo=${to}`);
        if (!res.ok) throw new Error('holidays');
        return (await res.json()) as { startDate: string; endDate: string }[];
      })
    );

    const W = 720, T = 20, barH = 90, bandH = 10, gap = 4, L = 4;
    const H = T + barH + 16 + HOLIDAY_COUNTRIES.length * (bandH + gap) + 14;
    const slot = (W - L) / days.length;
    const avgs = days.map((d) => perDay.get(d)!.sum / perDay.get(d)!.n);
    const max = Math.max(1, ...avgs);
    const xOf = (iso: string) => {
      const i = days.findIndex((d) => d >= iso);
      return L + slot * (i === -1 ? days.length : i);
    };
    let svg = `<svg viewBox="0 0 ${W} ${H}" class="nerd-svg" role="img" aria-label="${esc(t(lang, 'nerd.holidays.title'))}">`;
    avgs.forEach((a, i) => {
      const h = (barH * a) / max;
      svg += `<rect x="${L + slot * i + 1}" y="${T + barH - h}" width="${Math.max(1, slot - 2)}" height="${h}" fill="var(--color-accent)" opacity="0.85"><title>${days[i]} – ${esc(t(lang, 'nerd.holidays.avg'))}: ${num(a)} ${t(lang, 'nerd.min')}</title></rect>`;
    });
    svg += `<text x="${L}" y="12" class="nerd-svg__t">${num(max, 0)} ${t(lang, 'nerd.min')}</text>`;
    HOLIDAY_COUNTRIES.forEach((c, ci) => {
      const y = T + barH + 16 + ci * (bandH + gap);
      svg += `<text x="${W - 2}" y="${y + 8}" text-anchor="end" class="nerd-svg__t">${c.code}</text>`;
      // Regional ranges overlap: merge them so bands don't stack their opacity.
      const merged: { startDate: string; endDate: string }[] = [];
      for (const h of [...lists[ci]].sort((a, b) => a.startDate.localeCompare(b.startDate))) {
        const last = merged[merged.length - 1];
        if (last && h.startDate <= last.endDate) last.endDate = h.endDate > last.endDate ? h.endDate : last.endDate;
        else merged.push({ startDate: h.startDate, endDate: h.endDate });
      }
      for (const h of merged) {
        const x1 = xOf(h.startDate < from ? from : h.startDate);
        const x2 = xOf(h.endDate >= to ? '9999' : new Date(Date.parse(h.endDate) + 86_400_000).toISOString().slice(0, 10));
        if (x2 > x1) svg += `<rect x="${x1}" y="${y}" width="${x2 - x1}" height="${bandH}" rx="2" fill="${c.color}" opacity="0.85"><title>${c.code}: ${h.startDate} – ${h.endDate}</title></rect>`;
      }
    });
    svg += `<text x="${L}" y="${H - 2}" class="nerd-svg__t">${from}</text><text x="${W - 2}" y="${H - 2}" text-anchor="end" class="nerd-svg__t">${to}</text></svg>`;
    $('nerd-holidays-chart').innerHTML = svg;
    $('nerd-holidays').hidden = false;
  } catch {
    /* hide the card silently */
  }
}

// ─── Correlations (computed server-side from snapshots + stored weather) ────

function renderCorrelations(c: NonNullable<Stats['correlations']>) {
  const fill = (key: Parameters<typeof t>[1], vars: Record<string, string>) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), t(lang, key));
  let rows = '';

  const ns = c.northSouth;
  if (ns.sameHour !== null) {
    rows += `<tr><td>${esc(t(lang, 'nerd.corr.northSouth'))}</td><td>${num(ns.sameHour, 2)}</td><td>${esc(describeR(ns.sameHour))}</td></tr>`;
  }
  if (ns.best) {
    const lag = ns.best.lagHours;
    const label = lag === 0
      ? t(lang, 'nerd.corr.lagSame')
      : lag > 0 ? fill('nerd.corr.lagSouthLater', { h: String(lag) }) : fill('nerd.corr.lagSouthEarlier', { h: String(-lag) });
    rows += `<tr><td>${esc(t(lang, 'nerd.corr.northSouthLead'))}: ${esc(label)}</td><td>${num(ns.best.r, 2)}</td><td>${esc(describeR(ns.best.r))}</td></tr>`;
  }

  const hasWeather = c.weather.some((w) => w.hours >= 24);
  if (hasWeather) {
    const vars = [['temperature', 'nerd.weather.temp'], ['precipitation', 'nerd.weather.rain'], ['snowfall', 'nerd.weather.snow']] as const;
    for (const w of c.weather) {
      for (const [k, label] of vars) {
        const r = w.r[k];
        rows += `<tr><td>${esc(t(lang, 'nerd.corr.weatherDb'))} · ${esc(portalName(w.portal))} · ${esc(t(lang, label))}</td><td>${r === null ? '–' : num(r, 2)}</td><td>${esc(describeR(r))}</td></tr>`;
      }
      rows += `<tr><td>${esc(portalName(w.portal))} · ${esc(t(lang, 'nerd.weather.wetVsDry'))}</td><td colspan="2">${num(w.wetAvg)} ${t(lang, 'nerd.min')} (${w.wetHours}) vs ${num(w.dryAvg)} ${t(lang, 'nerd.min')}</td></tr>`;
    }
  } else {
    rows += `<tr><td colspan="3">${esc(t(lang, 'nerd.corr.weatherEmpty'))}</td></tr>`;
  }

  for (const portal of ['north', 'south'] as const) {
    const w = c.weekend[portal];
    if (w?.ratio !== null && w?.ratio !== undefined) {
      rows += `<tr><td>${esc(t(lang, 'nerd.corr.weekend'))} · ${esc(portalName(portal))}</td><td colspan="2">${esc(fill('nerd.corr.weekendRatio', { x: num(w.ratio, 2) }))}</td></tr>`;
    }
    const ac = c.afterClosure[portal] as { ratio: number | null } | undefined;
    if (ac?.ratio !== null && ac?.ratio !== undefined) {
      rows += `<tr><td>${esc(t(lang, 'nerd.corr.afterClosure'))} · ${esc(portalName(portal))}</td><td colspan="2">${esc(fill('nerd.corr.afterClosureRatio', { x: num(ac.ratio, 2), n: String(c.afterClosure.events) }))}</td></tr>`;
    }
  }

  $('nerd-corr-body').innerHTML = rows
    ? `<div class="nerd-scroll"><table class="nerd-table"><tbody>${rows}</tbody></table></div>`
    : `<p class="nerd-card__sub">${esc(t(lang, 'nerd.corr.none'))}</p>`;
  $('nerd-corr').hidden = false;
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
  if (s.correlations) renderCorrelations(s.correlations);
  void renderTrain();
  void renderWeather(s.hourly30d ?? []);
  void renderHolidays(s.hourly30d ?? []);
}

void main();
