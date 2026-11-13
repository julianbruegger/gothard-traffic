<?php

declare(strict_types=1);

/**
 * Tests ForecastTable (forecast-days.json -> crawler-readable text + table) and
 * the forecast markers in Ssr::render with a fixture file and a fixed "now".
 *
 * Run: php server/cron/tests/test-forecast-table.php
 */

$root = dirname(__DIR__, 3);
$tmp  = sys_get_temp_dir() . '/fc-test-' . bin2hex(random_bytes(4));
mkdir($tmp . '/lib', 0777, true);
foreach (glob($root . '/server/lib/*.php') as $f) {
    copy($f, $tmp . '/lib/' . basename($f));
}
copy($root . '/site/src/data/translations.json', $tmp . '/translations.json');
require_once $tmp . '/lib/Ssr.php';

$p = static fn (int $min, ?int $hour, float $km = 0.0): array => ['peakMin' => $min, 'peakHour' => $hour, 'peakKm' => $km, 'busyMin' => $min * 2];
$fixture = [
    'generated' => '2026-11-10T08:00:00Z',
    'days' => [
        ['date' => '2026-11-11', 'north' => $p(90, 10), 'south' => $p(90, 10), 'holiday' => null], // yesterday: must not show
        ['date' => '2026-11-12', 'north' => $p(25, 15), 'south' => $p(3, 16), 'holiday' => null],
        ['date' => '2026-11-13', 'north' => $p(6, 13), 'south' => $p(10, 15), 'holiday' => null],
        ['date' => '2026-11-14', 'north' => $p(40, 9), 'south' => $p(7, 14), 'holiday' => ['de' => 'Ferien <b>', 'en' => "Holiday's"]],
        ['date' => '2026-11-15', 'north' => $p(0, null), 'south' => $p(17, 16), 'holiday' => null],
        ['date' => '2026-11-16', 'north' => $p(0, null), 'south' => $p(0, null), 'holiday' => null],
        ['date' => '2026-11-17', 'north' => $p(0, null), 'south' => $p(0, null), 'holiday' => null],
        ['date' => '2026-11-18', 'north' => $p(0, null), 'south' => $p(0, null), 'holiday' => null],
        ['date' => '2026-11-19', 'north' => $p(0, null), 'south' => $p(0, null), 'holiday' => null],
        ['date' => '2026-11-20', 'north' => $p(99, 12), 'south' => $p(0, null), 'holiday' => null], // day 9: not in the week table
        ['date' => 'garbage', 'north' => $p(1, 1), 'south' => $p(1, 1)],                         // dropped
        ['date' => '2026-12-24', 'north' => $p(30, 11), 'south' => $p(4, 12), 'holiday' => ['de' => 'Weihnachtsferien', 'en' => 'Christmas holidays']],
        ['date' => '2026-12-26', 'north' => $p(2, 11), 'south' => $p(55, 15), 'holiday' => ['de' => 'Weihnachtsferien', 'en' => 'Christmas holidays']],
    ],
];
file_put_contents($tmp . '/forecast-days.json', json_encode($fixture));
$rows = ForecastTable::load($tmp . '/forecast-days.json');

// 2026-11-12 23:30 UTC is already 13 Nov 00:30 in Zurich; 22:30 UTC is still the 12th.
$now     = new DateTimeImmutable('2026-11-12T10:00:00Z');
$lateNow = new DateTimeImmutable('2026-11-12T23:30:00Z');
$quietNow = new DateTimeImmutable('2026-11-16T10:00:00Z');

$de  = ForecastTable::week($rows, 'de', $now);
$en  = ForecastTable::week($rows, 'en', $now);
$late = ForecastTable::week($rows, 'de', $lateNow);
$quiet = ForecastTable::week($rows, 'de', $quietNow);
$range = ForecastTable::range($rows, 'de', $now, '2026-12-20', '2027-01-04');
$rangeEn = ForecastTable::range($rows, 'en', $now, '2026-12-20', '2027-01-04');

$tpl = '<html lang="de" data-lang="de"><head><title>Own title</title><link rel="canonical" href="https://gotthard.jubr.app/forecasts"></head><body>'
    . '<div id="forecast-week"><!--SSR:forecast-week--><p>BUILD DAY</p><!--/SSR--></div>'
    . '<div><!--SSR:forecast-range:2026-12-20:2027-01-04--><p>BUILD RANGE</p><!--/SSR--></div>'
    . '<div><!--SSR:forecast-range:2026-11-01:2026-11-05--><p>PAST RANGE</p><!--/SSR--></div>'
    . '</body></html>';
$rendered = Ssr::render($tpl, [], 'de', '', ['head' => false, 'forecast' => $rows, 'now' => $now]);
$noJson   = Ssr::render($tpl, [], 'de', '', ['head' => false, 'forecast' => null, 'now' => $now]);
$stale    = Ssr::render($tpl, [], 'de', '', ['head' => false, 'forecast' => $rows, 'now' => new DateTimeImmutable('2027-06-01T10:00:00Z')]);

$assertions = [
    'load: invalid rows dropped, sorted'        => count($rows) === 12 && $rows[0]['date'] === '2026-11-11',
    'load: missing file -> null'                => ForecastTable::load($tmp . '/nope.json') === null,
    'week de: lead sentence'                    => str_contains($de, '<p class="fc-ssr__lead">Prognose heute, Do 12.11.: Richtung Süden Spitze ca. 25 Min um 15 Uhr, Richtung Norden kein nennenswerter Stau. Stärkster Tag der nächsten 7 Tage: Sa 14.11. (Richtung Süden ca. 40 Min).</p>'),
    'week en: lead sentence'                    => str_contains($en, 'Forecast today, Thu 12 Nov: southbound peak approx. 25 min around 15:00, northbound no relevant queue. Busiest of the next 7 days: Sat 14 Nov (southbound approx. 40 min).'),
    'week: today + 7 rows, not yesterday/day 9' => substr_count($de, '<tr><th scope="row">') === 8
                                                    && !str_contains($de, '2026-11-11') && !str_contains($de, '2026-11-20'),
    'week: today row labelled'                  => str_contains($de, '<time datetime="2026-11-12">Heute, Do 12.11.</time>'),
    'week: cells (north = southbound column)'   => str_contains($de, '<td>ca. 25 Min · 15 Uhr</td><td>kaum Stau (unter 5 Min)</td>'),
    'week: table headers'                       => str_contains($de, '<th scope="col">Tag</th><th scope="col">Richtung Süden</th><th scope="col">Richtung Norden</th>')
                                                    && str_contains($en, '<th scope="col">Day</th><th scope="col">Southbound</th><th scope="col">Northbound</th>'),
    'week: holiday escaped'                     => str_contains($de, '<small>Ferien &lt;b&gt;</small>') && str_contains($en, '<small>Holiday&#039;s</small>'),
    'week: Swiss midnight rolls the day'        => str_contains($late, 'Prognose heute, Fr 13.11.') && !str_contains($late, '2026-11-12'),
    'week: quiet day uses noQueues wording'     => str_contains($quiet, 'Prognose heute, Mo 16.11.: Keine nennenswerten Staus erwartet. Stärkster Tag der nächsten 7 Tage: Fr 20.11. (Richtung Süden ca. 99 Min).'),
    'week: no row for today -> empty'           => ForecastTable::week($rows, 'de', new DateTimeImmutable('2027-06-01T10:00:00Z')) === '',
    'range: only days in range'                 => substr_count($range, '<tr><th scope="row">') === 2 && str_contains($range, '2026-12-24') && str_contains($range, '2026-12-26'),
    'range de: lead'                            => str_contains($range, 'Prognose Do 24.12.–Sa 26.12., stärkster Tag: Sa 26.12. (Richtung Norden ca. 55 Min).'),
    'range en: lead'                            => str_contains($rangeEn, 'Forecast Thu 24 Dec–Sat 26 Dec, busiest day: Sat 26 Dec (northbound approx. 55 min).'),
    'range: past days skipped'                  => ForecastTable::range($rows, 'de', $now, '2026-11-01', '2026-11-12') !== ''
                                                    && !str_contains(ForecastTable::range($rows, 'de', $now, '2026-11-01', '2026-11-12'), '2026-11-11'),
    'range: invalid dates -> empty'             => ForecastTable::range($rows, 'de', $now, '2026-02-30', '2026-03-01') === ''
                                                    && ForecastTable::range($rows, 'de', $now, '2026-12-26', '2026-12-20') === '',
    'ssr: week marker replaced'                 => str_contains($rendered, '<!--SSR:forecast-week--><div class="fc-ssr">') && !str_contains($rendered, 'BUILD DAY'),
    'ssr: range marker replaced'                => str_contains($rendered, '<!--SSR:forecast-range:2026-12-20:2027-01-04--><div class="fc-ssr">') && !str_contains($rendered, 'BUILD RANGE'),
    'ssr: past range emptied'                   => str_contains($rendered, '<!--SSR:forecast-range:2026-11-01:2026-11-05--><!--/SSR-->'),
    'ssr: head untouched with head=false'       => str_contains($rendered, '<title>Own title</title>') && str_contains($rendered, 'href="https://gotthard.jubr.app/forecasts"'),
    'ssr: no JSON -> markers emptied'           => str_contains($noJson, '<!--SSR:forecast-week--><!--/SSR-->') && !str_contains($noJson, 'BUILD'),
    'ssr: no row for today -> empty, no stale'  => str_contains($stale, '<!--SSR:forecast-week--><!--/SSR-->') && !str_contains($stale, 'BUILD DAY'),
];

foreach (array_merge(glob($tmp . '/lib/*') ?: [], glob($tmp . '/*') ?: []) as $f) {
    if (is_file($f)) {
        unlink($f);
    }
}
@rmdir($tmp . '/lib');
@rmdir($tmp);

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}
exit($failures > 0 ? 1 : 0);
