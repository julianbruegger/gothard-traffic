// Asserts that buildSummary() (src/lib/format.ts) and Format::summary()
// (server/lib/Format.php) produce IDENTICAL answer-first summary sentences.
// Both sides are checked against the shared fixtures in
// server/cron/tests/summary-fixtures.json (the PHP side also in
// server/cron/tests/test-summary.php); when `php` is on PATH this script also
// runs Format::summary live on the same fixtures.
// The TS side runs in several process timezones: output must not depend on it.
// Run (in site/): node scripts/test-summary-parity.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures = fileURLToPath(new URL('../../server/cron/tests/summary-fixtures.json', import.meta.url));
const formatPhp = fileURLToPath(new URL('../../server/lib/Format.php', import.meta.url));
const outfile = `${root}.astro/summary-parity.mjs`;
mkdirSync(`${root}.astro`, { recursive: true });

// format.ts imports JSON and extensionless modules, so bundle it first.
await build({
  stdin: {
    contents: `
      import { readFileSync } from 'node:fs';
      import { buildSummary } from './src/lib/format';
      const cases = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      console.log(JSON.stringify(cases.map((c) => ({
        de: buildSummary(c.data, 'de', new Date(c.now)),
        en: buildSummary(c.data, 'en', new Date(c.now)),
      }))));
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});

const cases = JSON.parse(readFileSync(fixtures, 'utf8'));
let failed = false;

function compare(label, actual) {
  cases.forEach((c, i) => {
    for (const lang of ['de', 'en']) {
      const ok = actual[i]?.[lang] === c.expected[lang];
      if (!ok) {
        failed = true;
        console.error(`FAIL ${label} [${c.name}] ${lang}\n  expected: ${c.expected[lang]}\n  actual:   ${actual[i]?.[lang]}`);
      }
    }
  });
  if (!failed) console.log(`ok   ${label}: ${cases.length * 2} summaries match`);
}

for (const tz of ['UTC', 'America/New_York', 'Europe/Zurich', 'Asia/Tokyo']) {
  const r = spawnSync(process.execPath, [outfile, fixtures], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`TZ=${tz}: crashed\n${r.stderr}`);
    failed = true;
    continue;
  }
  compare(`TS  TZ=${tz}`, JSON.parse(r.stdout));
}

const phpCode = `
require ${JSON.stringify(formatPhp)};
$out = [];
foreach (json_decode(file_get_contents(${JSON.stringify(fixtures)}), true) as $c) {
    $now = new DateTimeImmutable($c['now']);
    $out[] = ['de' => Format::summary($c['data'], 'de', $now), 'en' => Format::summary($c['data'], 'en', $now)];
}
echo json_encode($out, JSON_UNESCAPED_UNICODE);
`;
const php = spawnSync('php', ['-d', 'date.timezone=America/New_York', '-r', phpCode], { encoding: 'utf8' });
if (php.error) {
  console.log('skip PHP: php not found on PATH (fixtures are still checked by server/cron/tests/test-summary.php)');
} else if (php.status !== 0) {
  console.error(`PHP crashed\n${php.stdout}${php.stderr}`);
  failed = true;
} else {
  compare('PHP live', JSON.parse(php.stdout));
}

process.exit(failed ? 1 : 0);
