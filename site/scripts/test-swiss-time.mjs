// Asserts that Swiss-time formatting is independent of the process timezone.
// Run: node scripts/test-swiss-time.mjs   (needs Node >= 22.18 for TS type stripping)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mod = fileURLToPath(new URL('../src/lib/swiss-time.ts', import.meta.url));

const child = `
import { fmtTime, fmtDateTime, fmtDayMonth, swissIsoDate, fmtIsoDayMonth } from ${JSON.stringify(mod)};
const d = new Date('2026-11-11T22:00:00Z');
console.log(JSON.stringify([
  fmtTime(d), fmtDateTime(d, 'de'), fmtDateTime(d, 'en'),
  fmtDayMonth(d, 'de'), fmtDayMonth(d, 'en'), swissIsoDate(d), fmtIsoDayMonth('2026-07-18', 'en'),
]));
`;

// 2026-11-11T22:00Z is 23:00 on 11 Nov in Zurich, whatever TZ the process runs in.
const expected = ['23:00', '11.11.2026, 23:00', '11 Nov 2026, 23:00', '11.11.', '11 Nov', '2026-11-11', '18 Jul'];
let failed = false;
for (const tz of ['UTC', 'America/New_York', 'Europe/Zurich', 'Asia/Tokyo']) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`TZ=${tz}: crashed\n${r.stderr}`);
    failed = true;
    continue;
  }
  const ok = JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} TZ=${tz} ${r.stdout.trim()}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
