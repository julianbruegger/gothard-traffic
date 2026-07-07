import { isLang, DEFAULT_LANG, t } from '../lib/i18n';
import { formatKm, formatMinutes, formatUpdated, statusLabel, passStatusLabel, buildSummary } from '../lib/format';
import { buildSparkline } from '../lib/chart';
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

function renderData(data: GotthardData) {
  setAttr('status-badge', 'data-status', data.tunnel.status);
  setText('status-label', statusLabel(data.tunnel.status, lang));
  setText('summary', buildSummary(data, lang));
  setText('hero-updated', formatUpdated(data.updated, lang));
  if (data.updated) setAttr('hero-updated', 'datetime', data.updated);

  setText('north-queue', formatKm(data.tunnel.north.queueKm, lang));
  setText('north-wait', formatMinutes(data.tunnel.north.waitMinutes, lang));
  if (data.tunnel.north.cause) setText('north-cause', data.tunnel.north.cause);

  setText('south-queue', formatKm(data.tunnel.south.queueKm, lang));
  setText('south-wait', formatMinutes(data.tunnel.south.waitMinutes, lang));
  if (data.tunnel.south.cause) setText('south-cause', data.tunnel.south.cause);

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

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(`${url}?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function tick() {
  const [data, history] = await Promise.all([
    fetchJson<GotthardData>('/data/gotthard.json'),
    fetchJson<HistoryPoint[]>('/data/history.json'),
  ]);
  if (data) renderData(data);
  else setText('summary', t(lang, 'hero.dataUnavailable'));
  if (history) renderHistory(history);
}

tick();
setInterval(tick, POLL_INTERVAL_MS);
