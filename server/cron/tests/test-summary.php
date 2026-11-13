<?php

declare(strict_types=1);

/**
 * Answer-first summary (Format::summary) against the shared fixtures that
 * site/scripts/test-summary-parity.mjs also checks buildSummary() against, so
 * PHP and TS stay word-for-word identical. Also covers the stale guard and the
 * plain-text answer of api/summary.php.
 *
 * Run: php server/cron/tests/test-summary.php
 */

require __DIR__ . '/../../lib/Format.php';

// The output must not depend on the server's default timezone.
date_default_timezone_set('America/New_York');

$assertions = [];

$cases = json_decode((string) file_get_contents(__DIR__ . '/summary-fixtures.json'), true);
$assertions['fixtures load'] = is_array($cases) && count($cases) >= 8;
foreach ($cases as $c) {
    $now = new DateTimeImmutable($c['now']);
    foreach (['de', 'en'] as $lang) {
        $actual = Format::summary($c['data'], $lang, $now);
        $ok = $actual === $c['expected'][$lang];
        $assertions["fixture [{$c['name']}] {$lang}"] = $ok;
        if (!$ok) {
            echo "  expected: {$c['expected'][$lang]}\n  actual:   {$actual}\n";
        }
    }
}

$base = $cases[0]['data'];
$now = new DateTimeImmutable('2026-11-11T09:30:00Z');

// Target shape from issue #64.
$assertions['de target shape'] = Format::summary($base, 'de', $now)
    === 'Gotthard-Strassentunnel, 11.11.2026, 10:27 Uhr: kein Stau in beiden Richtungen. Gotthardpass: Winterschliessung. Nächste geplante Sperrung: heute 23:00–01:00 Uhr (Unterhaltsarbeiten).';
$assertions['en target shape'] = Format::summary($base, 'en', $now)
    === 'Gotthard road tunnel, 11 Nov 2026, 10:27: no queue in either direction. Gotthard Pass: closed for winter. Next planned closure: tonight 23:00–01:00 (maintenance).';

// Once the planned closure has ended it is no longer announced.
$after = new DateTimeImmutable('2026-11-12T00:30:00Z');
$assertions['ended closure dropped'] = !str_contains(Format::summary($base, 'de', $after), 'Sperrung');
// Running closure (started, not ended) is still announced.
$during = new DateTimeImmutable('2026-11-11T22:30:00Z');
$assertions['running closure kept'] = str_contains(Format::summary($base, 'en', $during), 'Next planned closure: tonight 23:00–01:00');
// Missing planned closures key behaves like an empty list.
$noKey = $base;
unset($noKey['tunnel']['plannedClosures']);
$assertions['no plannedClosures key'] = !str_contains(Format::summary($noKey, 'de', $now), 'Sperrung');
// Default $now still works (no exception, timestamp present).
$assertions['default now'] = str_starts_with(Format::summary($base, 'de'), 'Gotthard-Strassentunnel, 11.11.2026, 10:27 Uhr: ');

// Freshness mirrors dataFreshness() in format.ts (20 min stale, 6 h unavailable).
$assertions['freshness fresh'] = Format::freshness('2026-11-11T09:27:03+00:00', $now) === ['level' => 'fresh', 'ageMin' => 2];
$assertions['freshness 20 min still fresh'] = Format::freshness('2026-11-11T09:10:00Z', $now)['level'] === 'fresh';
$assertions['freshness 21 min stale'] = Format::freshness('2026-11-11T09:09:00Z', $now) === ['level' => 'stale', 'ageMin' => 21];
$assertions['freshness 7 h unavailable'] = Format::freshness('2026-11-11T02:30:00Z', $now)['level'] === 'unavailable';
$assertions['freshness null'] = Format::freshness(null, $now) === ['level' => 'unavailable', 'ageMin' => null];
$assertions['age 45'] = Format::age(45, 'de') === '45 Min';
$assertions['age 125 de'] = Format::age(125, 'de') === '2 Std 5 Min';
$assertions['age 120 en'] = Format::age(120, 'en') === '2 h';

// Plain-text answer for api/summary.php.
$fresh = Format::plainAnswer($base, 'en', 'https://gotthard.jubr.app/', $now);
$assertions['plain en: answer + source + page'] = $fresh === Format::summary($base, 'en', $now)
    . ' Source: opentransportdata.swiss (ASTRA Traffic Situations). Live page: https://gotthard.jubr.app/en';
$assertions['plain de: live page is /'] = str_ends_with(Format::plainAnswer($base, 'de', 'https://gotthard.jubr.app', $now), 'Quelle: opentransportdata.swiss (ASTRA Traffic Situations). Live-Seite: https://gotthard.jubr.app/');

$late = new DateTimeImmutable('2026-11-11T10:12:00Z'); // 45 min after the reading
$staleDe = Format::plainAnswer($base, 'de', 'https://gotthard.jubr.app', $late);
$staleEn = Format::plainAnswer($base, 'en', 'https://gotthard.jubr.app', $late);
$assertions['stale de: no current claim'] = str_starts_with($staleDe, 'Gotthard-Strassentunnel: keine aktuellen Verkehrsdaten. Die letzte Messung ist vom 11.11.2026, 10:27 Uhr (vor 44 Min)')
    && !str_contains($staleDe, 'kein Stau');
$assertions['stale en: no current claim'] = str_contains($staleEn, 'The last reading is from 11 Nov 2026, 10:27 (44 min ago), so the current traffic situation is unknown.')
    && !str_contains($staleEn, 'no queue');
$noTs = $base;
$noTs['updated'] = null;
$assertions['no timestamp: unavailable'] = str_starts_with(Format::plainAnswer($noTs, 'en', 'https://gotthard.jubr.app', $now), 'Gotthard road tunnel: live traffic data is currently not available');

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}
exit($failures > 0 ? 1 : 0);
