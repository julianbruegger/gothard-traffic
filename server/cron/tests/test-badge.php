<?php

declare(strict_types=1);

/**
 * Status badge (lib/Badge.php + api/badge.php): wording, colour, escaping and
 * valid SVG.
 *
 * Run: php server/cron/tests/test-badge.php
 */

$root = dirname(__DIR__, 3);
require $root . '/server/lib/Badge.php';

$now = new DateTimeImmutable('2026-11-11T09:30:00Z');
function data(string $status, ?float $nKm, ?int $nWait, ?float $sKm = null, ?int $sWait = null, ?string $updated = '2026-11-11T09:27:03+00:00'): array
{
    return [
        'updated' => $updated,
        'tunnel' => [
            'status' => $status,
            'north' => ['queueKm' => $nKm, 'waitMinutes' => $nWait],
            'south' => ['queueKm' => $sKm, 'waitMinutes' => $sWait],
        ],
    ];
}

$a = [];
$m = Badge::model(data('open', 0.0, null, 0.0), 'de', 'both', $now);
$a['clear de'] = $m === ['label' => 'Gotthard', 'value' => 'freie Fahrt', 'color' => '#2e7d32'];
$a['clear en'] = Badge::model(data('open', 0.0, null, null), 'en', 'both', $now)['value'] === 'no queue';
$a['closed']   = Badge::model(data('closed', 2.0, 10), 'de', 'both', $now)['value'] === 'gesperrt'
    && Badge::model(data('closed', null, null), 'en', 'north', $now)['color'] === '#c62828';
$a['north queue, both'] = Badge::model(data('congested', 3.2, 25, 0.0), 'de', 'both', $now)['value'] === 'Nord 3.2 km · 25 Min';
$a['north queue, en']   = Badge::model(data('congested', 3.2, 25, 0.0), 'en', 'both', $now)['value'] === 'north 3.2 km · 25 min';
$a['both queues']       = Badge::model(data('congested', 3.2, 25, 1.0, 5), 'de', 'both', $now)['value'] === 'Nord 3.2 km · Süd 1.0 km';
$a['dir=north']         = Badge::model(data('congested', 3.2, 25, 1.0, 5), 'de', 'north', $now) === ['label' => 'Gotthard Nord', 'value' => '3.2 km · 25 Min', 'color' => '#b45309'];
$a['dir=south, no wait'] = Badge::model(data('congested', 3.2, 25, 1.0, null), 'en', 'south', $now)['value'] === '1.0 km';
$a['dir=south clear']   = Badge::model(data('congested', 3.2, 25, 0.0), 'en', 'south', $now) === ['label' => 'Gotthard south', 'value' => 'no queue', 'color' => '#2e7d32'];
$a['unknown']           = Badge::model(data('unknown', null, null), 'de', 'both', $now)['value'] === 'unbekannt';
$a['stale']             = Badge::model(data('open', 0.0, null, 0.0, null, '2026-11-11T08:00:00Z'), 'de', 'both', $now)['value'] === 'Daten veraltet';
$a['no data']           = Badge::model(['updated' => null], 'en', 'both', $now) === ['label' => 'Gotthard', 'value' => 'no data', 'color' => '#6b7280'];
$a['bad dir -> both']   = Badge::model(data('open', 0.0, null), 'de', '../x', $now)['label'] === 'Gotthard';

$svg = Badge::svg('Gotthard', '<script>&"\'', '#2e7d32');
$a['text escaped'] = !str_contains($svg, '<script>') && str_contains($svg, '&lt;script&gt;&amp;&quot;&apos;');
$a['bad colour replaced'] = str_contains(Badge::svg('a', 'b', 'red;" onload="x'), 'fill="#6b7280"');
libxml_use_internal_errors(true);
$doc = simplexml_load_string(Badge::svg('Gotthard Süd', '3.2 km · 25 Min', '#b45309'));
$a['valid xml'] = $doc !== false && (string) $doc['role'] === 'img' && str_contains((string) $doc['aria-label'], 'Gotthard Süd: 3.2 km · 25 Min');
$a['width grows with text'] = (int) simplexml_load_string(Badge::svg('Gotthard', 'Nord 12.0 km · 120 Min', '#b45309'))['width']
    > (int) simplexml_load_string(Badge::svg('Gotthard', 'gesperrt', '#c62828'))['width'];

// Endpoint without a database (no cron/config.php): still a valid SVG.
$tmp = sys_get_temp_dir() . '/badge-test-' . bin2hex(random_bytes(4));
mkdir($tmp . '/lib', 0777, true);
mkdir($tmp . '/api', 0777, true);
foreach (glob($root . '/server/lib/*.php') as $f) {
    copy($f, $tmp . '/lib/' . basename($f));
}
copy($root . '/server/api/badge.php', $tmp . '/api/badge.php');
copy($root . '/site/src/data/translations.json', $tmp . '/translations.json');
$code = '$_GET = ["lang" => "en", "dir" => "north"]; require ' . var_export($tmp . '/api/badge.php', true) . ';';
$out = (string) shell_exec('php -d display_errors=1 -r ' . escapeshellarg($code) . ' 2>&1');
$a['endpoint: svg without db'] = str_starts_with($out, '<svg') && str_contains($out, 'Gotthard north: no data');
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $f) {
    $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
}
@rmdir($tmp);

$failures = 0;
foreach ($a as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}
exit($failures > 0 ? 1 : 0);
