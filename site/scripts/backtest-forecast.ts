// Backtest: would the forecast have predicted the queues we actually measured?
//
// Replays every measured day in observed-days.json against:
//   legacy   — the previous model (TCS tweet profiles + hand-tuned season); it
//              never saw this data, so it is a genuine out-of-sample test.
//   rolling  — the measured model, re-fitted every Monday on ONLY the days before
//              that Monday, then asked to predict the coming week. This is what
//              the site would really have shown, so it is the honest score.
//   in-sample— the measured model fitted on everything (upper bound; not a test).
//   lastweek — naive baseline: "same as the same weekday last week".
//   mean4wk  — naive baseline: mean of the same weekday over the last four weeks.
//
// The rolling model is also scored per forecast horizon (days ahead of its
// Monday refit: 1, 2-3, 4-7), and a pass/fail summary checks the targets.
//
// Run:  npm run backtest     (from site/)

import { generateDayCurve, calendarLevelOf, OBSERVED_MODEL } from '../src/lib/forecast';
import { fitObservedModel, observedDays, type ObservedDay, type ObservedModel } from '../src/lib/observed-model';

const KM_TO_MIN = 10;          // ASTRA: 10 min per km
const JAM_KM = 3.5;            // forecast.ts "isPeak" / level 'high' threshold
const MIN_TRAIN_DAYS = 28;     // rolling model needs four weeks before its first prediction
// Optional overrides for tuning: BT_RW=0.8 BT_TAU=10 npm run backtest
const FIT_OPTS = {
  ...(process.env.BT_RW ? { recentWeight: +process.env.BT_RW } : {}),
  ...(process.env.BT_TAU ? { recentTau: +process.env.BT_TAU } : {}),
  ...(process.env.BT_PEAK ? { peakScale: +process.env.BT_PEAK } : {}),
  ...(process.env.BT_PW ? { persistWeight: +process.env.BT_PW } : {}),
  ...(process.env.BT_PTAU ? { persistTau: +process.env.BT_PTAU } : {}),
};

type Dir = 'n' | 's';
interface Pred { wait: number[]; high: number[] } // 24 hourly values, minutes

const byDate = new Map(observedDays.map((d) => [d.d, d]));
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(iso + 'T12:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
const dowOf = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();

function curvePred(iso: string, model: ObservedModel | null): Record<Dir, Pred> {
  // 10:00 UTC is mid-day in Zurich in both CET and CEST.
  const c = generateDayCurve(new Date(iso + 'T10:00:00Z'), 'de', 60, model);
  const pts = c.points.slice(0, 24);
  return {
    n: { wait: pts.map((p) => p.northWait), high: pts.map((p) => p.northWaitHigh) },
    s: { wait: pts.map((p) => p.southWait), high: pts.map((p) => p.southWaitHigh) },
  };
}

function lastWeekPred(iso: string): Record<Dir, Pred> | null {
  const prev = byDate.get(addDays(iso, -7));
  if (!prev) return null;
  const toMin = (a: (number | null)[]) => a.map((v) => (v ?? 0) * KM_TO_MIN);
  return {
    n: { wait: toMin(prev.n), high: toMin(prev.n) },
    s: { wait: toMin(prev.s), high: toMin(prev.s) },
  };
}

function mean4Pred(iso: string): Record<Dir, Pred> | null {
  const prev = [7, 14, 21, 28].map((k) => byDate.get(addDays(iso, -k))).filter((d): d is ObservedDay => !!d);
  if (prev.length < 2) return null;
  const avg = (dir: Dir) =>
    Array.from({ length: 24 }, (_, h) => {
      const v = prev.map((d) => d[dir][h]).filter((x): x is number => x !== null);
      return (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0) * KM_TO_MIN;
    });
  return { n: { wait: avg('n'), high: avg('n') }, s: { wait: avg('s'), high: avg('s') } };
}

// ─── Rolling-origin models (refit every Monday on the past only) ──────────────

const firstDay = observedDays[0].d;
const rollingCache = new Map<string, ObservedModel | null>();
function rollingModelFor(iso: string): ObservedModel | null {
  let monday = iso;
  while (dowOf(monday) !== 1) monday = addDays(monday, -1);
  if (!rollingCache.has(monday)) {
    const train = observedDays.filter((d) => d.d < monday);
    rollingCache.set(monday, train.length >= MIN_TRAIN_DAYS ? fitObservedModel(train, calendarLevelOf, FIT_OPTS) : null);
  }
  return rollingCache.get(monday) ?? null;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

interface Acc {
  absErr: number; err: number; hours: number;
  inBand: number;
  levelHit: number;
  peakAbsErr: number; peakDays: number;
  timingErr: number; timingDays: number;
  tp: number; fp: number; fn: number; tn: number;
  monthAbs: Map<string, { abs: number; n: number }>;
}
const newAcc = (): Acc => ({
  absErr: 0, err: 0, hours: 0, inBand: 0, levelHit: 0, peakAbsErr: 0, peakDays: 0,
  timingErr: 0, timingDays: 0, tp: 0, fp: 0, fn: 0, tn: 0, monthAbs: new Map(),
});

const level = (km: number) => (km >= 6.5 ? 3 : km >= 3.5 ? 2 : km >= 1.5 ? 1 : 0);

function score(acc: Acc, day: ObservedDay, dir: Dir, p: Pred) {
  const truth = day[dir];
  let tPeak = -1, tPeakH = 0, pPeak = -1, pPeakH = 0;
  const mon = day.d.slice(0, 7);
  const m = acc.monthAbs.get(mon) ?? { abs: 0, n: 0 };
  for (let h = 0; h < 24; h++) {
    const t = truth[h];
    if (t === null) continue;
    const tMin = t * KM_TO_MIN;
    const e = p.wait[h] - tMin;
    acc.absErr += Math.abs(e); acc.err += e; acc.hours++;
    m.abs += Math.abs(e); m.n++;
    if (tMin <= p.high[h] + 0.5) acc.inBand++;
    if (level(t) === level(p.wait[h] / KM_TO_MIN)) acc.levelHit++;
    if (tMin > tPeak) { tPeak = tMin; tPeakH = h; }
    if (p.wait[h] > pPeak) { pPeak = p.wait[h]; pPeakH = h; }
  }
  acc.monthAbs.set(mon, m);
  acc.peakAbsErr += Math.abs(pPeak - tPeak); acc.peakDays++;
  if (tPeak >= 30 && pPeak > 0) {
    acc.timingErr += Math.abs(pPeakH - tPeakH); acc.timingDays++;
  }
  const tJam = tPeak >= JAM_KM * KM_TO_MIN, pJam = pPeak >= JAM_KM * KM_TO_MIN;
  if (tJam && pJam) acc.tp++; else if (!tJam && pJam) acc.fp++; else if (tJam) acc.fn++; else acc.tn++;
}

type ModelName = 'legacy' | 'rolling' | 'in-sample' | 'lastweek' | 'mean4wk';
const MODELS: ModelName[] = ['legacy', 'rolling', 'in-sample', 'lastweek', 'mean4wk'];
const acc: Record<ModelName, Record<Dir, Acc>> = Object.fromEntries(
  MODELS.map((m) => [m, { n: newAcc(), s: newAcc() }]),
) as Record<ModelName, Record<Dir, Acc>>;
const legacyFull = { n: newAcc(), s: newAcc() };
// Rolling model by horizon: days ahead of the Monday refit (Monday = 1 ... Sunday = 7).
const HORIZONS: [string, (h: number) => boolean][] = [
  ['1 day', (h) => h === 1], ['2-3 days', (h) => h >= 2 && h <= 3], ['4-7 days', (h) => h >= 4],
];
const horizonAcc = HORIZONS.map(() => ({ n: newAcc(), s: newAcc() }));

// Common evaluation window: days where every model can make a prediction.
let evalDays = 0;
for (const day of observedDays) {
  const legacy = curvePred(day.d, null);
  for (const dir of ['n', 's'] as Dir[]) score(legacyFull[dir], day, dir, legacy[dir]);

  const rm = rollingModelFor(day.d);
  const lw = lastWeekPred(day.d);
  const m4 = mean4Pred(day.d);
  if (!rm || !lw || !m4) continue;
  evalDays++;
  const preds: Record<ModelName, Record<Dir, Pred>> = {
    legacy,
    rolling: curvePred(day.d, rm),
    'in-sample': curvePred(day.d, OBSERVED_MODEL),
    lastweek: lw,
    mean4wk: m4,
  };
  const horizon = (dowOf(day.d) + 6) % 7 + 1;
  HORIZONS.forEach(([, test], i) => {
    if (test(horizon)) for (const dir of ['n', 's'] as Dir[]) score(horizonAcc[i][dir], day, dir, preds.rolling[dir]);
  });
  for (const m of MODELS) for (const dir of ['n', 's'] as Dir[]) score(acc[m][dir], day, dir, preds[m][dir]);
}

// ─── Report ───────────────────────────────────────────────────────────────────

const f1 = (v: number) => v.toFixed(1);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const DIR_LABEL: Record<Dir, string> = { n: 'Nord (Göschenen, → Süden)', s: 'Süd (Airolo, → Norden)' };

function table(title: string, rows: [string, Record<Dir, Acc>][]) {
  console.log(`\n${title}`);
  for (const dir of ['n', 's'] as Dir[]) {
    console.log(`\n  ${DIR_LABEL[dir]}`);
    console.log('  model       MAE/h  bias/h  peak-MAE  timing  in-band  level  jam-recall  jam-precision');
    for (const [name, a] of rows) {
      const x = a[dir];
      const rec = x.tp + x.fn ? x.tp / (x.tp + x.fn) : NaN;
      const prec = x.tp + x.fp ? x.tp / (x.tp + x.fp) : NaN;
      console.log(
        `  ${name.padEnd(10)} ${f1(x.absErr / x.hours).padStart(5)}m ${f1(x.err / x.hours).padStart(6)}m ` +
        `${f1(x.peakAbsErr / x.peakDays).padStart(8)}m ${f1(x.timingErr / Math.max(1, x.timingDays)).padStart(6)}h ` +
        `${pct(x.inBand / x.hours).padStart(8)} ${pct(x.levelHit / x.hours).padStart(6)} ` +
        `${(Number.isNaN(rec) ? '–' : pct(rec)).padStart(11)} ${(Number.isNaN(prec) ? '–' : pct(prec)).padStart(14)}`,
      );
    }
  }
}

const m = OBSERVED_MODEL;
console.log(`Measured days: ${observedDays.length} (${firstDay} → ${observedDays.at(-1)!.d})`);
if (m) {
  console.log(`Month correction N: ${m.monthCorr.n.map((v, i) => (m.monthDays[i] ? `${i + 1}:${v}` : null)).filter(Boolean).join('  ')}`);
  console.log(`Month correction S: ${m.monthCorr.s.map((v, i) => (m.monthDays[i] ? `${i + 1}:${v}` : null)).filter(Boolean).join('  ')}`);
}

table(`Legacy model over ALL ${observedDays.length} measured days`, [['legacy', legacyFull]]);
table(`Common window: ${evalDays} days (rolling model needs ${MIN_TRAIN_DAYS} days of history first)`,
  MODELS.map((name) => [name, acc[name]]));

table('Rolling model by horizon (days ahead of the weekly refit)', HORIZONS.map(([name], i) => [name, horizonAcc[i]]));

console.log('\nMAE per hour by month (minutes), N / S:');
const months = [...acc.rolling.n.monthAbs.keys()];
console.log('  model      ' + months.map((mo) => mo.padStart(13)).join(''));
for (const name of MODELS) {
  console.log(`  ${name.padEnd(10)} ` + months.map((mo) => {
    const a = acc[name].n.monthAbs.get(mo)!, b = acc[name].s.monthAbs.get(mo)!;
    return `${f1(a.abs / a.n)} / ${f1(b.abs / b.n)}`.padStart(13);
  }).join(''));
}

// ─── Targets (issue #56) ──────────────────────────────────────────────────────

const mae = (a: Acc) => a.absErr / a.hours;
const recall = (a: Acc) => a.tp / Math.max(1, a.tp + a.fn);
const precision = (a: Acc) => a.tp / Math.max(1, a.tp + a.fp);
const timing = (a: Acc) => Math.round((a.timingErr / Math.max(1, a.timingDays)) * 10) / 10;
const checks: [string, boolean, string][] = [];
for (const dir of ['n', 's'] as Dir[]) {
  const r = acc.rolling[dir], lwk = acc['lastweek'][dir];
  const L = dir === 'n' ? 'Nord' : 'Süd';
  checks.push([`${L}: rolling MAE/h <= lastweek`, mae(r) <= mae(lwk), `${f1(mae(r))} vs ${f1(mae(lwk))} min`]);
  checks.push([`${L}: jam recall >= 70%`, recall(r) >= 0.7, pct(recall(r))]);
  checks.push([`${L}: jam precision >= 80%`, precision(r) >= 0.8, pct(precision(r))]);
  checks.push([`${L}: peak timing error <= 1.4 h`, timing(r) <= 1.4, `${f1(timing(r))} h`]);
}
console.log('\nTargets (rolling model):');
for (const [name, ok, val] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}  (${val})`);
console.log(`  ${checks.every(([, ok]) => ok) ? 'ALL TARGETS MET' : `${checks.filter(([, ok]) => !ok).length} of ${checks.length} targets missed`}`);

console.log(`
Legend: MAE/h = mean absolute error of the hourly wait (minutes); bias > 0 = forecast too high;
peak-MAE = error of the day's worst wait; timing = hours between forecast and real peak (days ≥30 min);
in-band = share of hours at or below the busy-day upper edge; level = same low/moderate/high/extreme class;
jam = day with a ≥${JAM_KM} km (${JAM_KM * KM_TO_MIN} min) peak.`);
