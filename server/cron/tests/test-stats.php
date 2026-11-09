<?php

declare(strict_types=1);

require __DIR__ . '/../../lib/StatsCalculator.php';

// 2026-08-03 is a Monday. 10:00 UTC = 12:00 Swiss summer time.
function row(string $t, string $status, ?string $reason, ?float $nKm, ?int $nW, ?float $sKm, ?int $sW): array
{
    return [
        'fetched_at' => $t, 'tunnel_status' => $status, 'closure_reason' => $reason,
        'north_queue_km' => $nKm, 'north_wait_min' => $nW, 'south_queue_km' => $sKm, 'south_wait_min' => $sW,
    ];
}

$rows = [
    row('2026-08-03 08:00:00', 'open', null, null, null, null, null),
    row('2026-08-03 10:00:00', 'congested', null, 2.0, 20, null, null),
    row('2026-08-03 10:10:00', 'congested', null, 4.0, 40, 1.0, 10),
    row('2026-08-03 10:20:00', 'closed', 'Baustelle', 1.0, 10, null, null),
    row('2026-08-03 10:30:00', 'closed', 'Baustelle', null, null, null, null),
    row('2026-08-03 10:40:00', 'open', null, null, null, null, null),
];

$s = (new StatsCalculator())->compute($rows, new DateTimeImmutable('2026-08-04 00:00:00', new DateTimeZone('UTC')));

$checks = [
    'heatmap Mon 12h north avg = (20+40+10+0+0)/5 = 14' => $s['heatmap']['north'][0][12] === 14.0,
    'heatmap has 7x24 grid'                       => count($s['heatmap']['south']) === 7 && count($s['heatmap']['south'][3]) === 24,
    'longest queue 4 km north'                    => $s['records']['longestQueue']['km'] === 4.0 && $s['records']['longestQueue']['portal'] === 'north',
    'longest wait 40'                             => $s['records']['longestWait']['minutes'] === 40,
    'worst day 2026-08-03 sum 80'                 => $s['records']['worstDay'] === ['date' => '2026-08-03', 'waitSum' => 80],
    'jam-free streak 10:30..10:40 = 0.2 h'        => $s['records']['longestJamFree']['hours'] === 0.2,
    'asymmetry month north avg 11.7'              => $s['asymmetry'][0]['month'] === '2026-08' && $s['asymmetry'][0]['north'] === 11.7,
    'minutes per km north = 10'                   => $s['minutesPerKm']['north'] === 10.0,
    'closures Baustelle 1 event, 0.2 h'           => $s['closures'][0] === ['reason' => 'Baustelle', 'count' => 1, 'hours' => 0.2],
    'build-up > 0'                                => $s['jamDynamics']['buildUpKmPerHour'] > 0,
    'dissolve > 0'                                => $s['jamDynamics']['dissolveKmPerHour'] > 0,
    'data quality: 6 snapshots, 1 gap'            => $s['dataQuality']['snapshots'] === 6 && $s['dataQuality']['gaps'] === 1,
    'last7d has 2 hourly buckets'                 => count($s['last7d']) === 2,
    'hourly30d has 2 hourly buckets'              => count($s['hourly30d']) === 2,
];

// Correlations: south follows north by 2 hours over 20 days of synthetic hours.
$rows2 = [];
$base = new DateTimeImmutable('2026-08-03 00:00:00', new DateTimeZone('UTC'));
$wave = static fn (int $i): float => 10 + 8 * sin($i * 0.7) + 5 * cos($i * 0.31);
for ($i = 0; $i < 480; $i++) {
    $n = max(0.0, $wave($i));
    $sv = max(0.0, $wave($i - 2));
    $rows2[] = row($base->modify("+{$i} hours")->format('Y-m-d H:i:s'), 'open', null, $n / 10, (int) round($n), $sv / 10, (int) round($sv));
}
$weather = [];
for ($i = 0; $i < 480; $i++) {
    $w = max(0.0, $wave($i));
    $weather[] = ['observed_at' => $base->modify("+{$i} hours")->format('Y-m-d H:i:s'), 'portal' => 'north',
        'temperature_c' => 5, 'precipitation_mm' => $w > 12 ? 1.0 : 0.0, 'snowfall_cm' => 0];
}
$c = (new StatsCalculator())->compute($rows2, new DateTimeImmutable('2026-08-24', new DateTimeZone('UTC')), $weather)['correlations'];
$checks['corr: best north/south lag is +2h']     = ($c['northSouth']['best']['lagHours'] ?? null) === 2;
$checks['corr: lagged r is strong']              = ($c['northSouth']['best']['r'] ?? 0) > 0.9;
$checks['corr: wet hours wait longer (north)']   = $c['weather'][0]['wetAvg'] > $c['weather'][0]['dryAvg'];
$checks['corr: precipitation r positive (north)'] = ($c['weather'][0]['r']['precipitation'] ?? 0) > 0.3;
$checks['corr: no south weather -> r null']      = $c['weather'][1]['r']['temperature'] === null;
$checks['corr: weekend ratio computed']          = $c['weekend']['north']['ratio'] !== null;
$checks['corr: no closures -> 0 events']         = $c['afterClosure']['events'] === 0;

$failures = 0;
foreach ($checks as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}\n";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
