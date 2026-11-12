<?php

declare(strict_types=1);

require __DIR__ . '/../lib/WeatherClient.php';

$cur = WeatherClient::parseCurrent([
    'current' => ['time' => '2026-11-09T20:15', 'temperature_2m' => 3.5, 'precipitation' => 0.2, 'snowfall' => 0.0, 'weather_code' => 61],
]);

$hourly = WeatherClient::parseHourly([
    'hourly' => [
        'time'           => ['2026-11-09T10:00', '2026-11-09T11:00', '2026-11-09T12:00'],
        'temperature_2m' => [1.5, 2.0, null],
        'precipitation'  => [0.0, 0.4, null],
        'snowfall'       => [0.0, 0.3, null],
        'weather_code'   => [3, 71, null],
    ],
]);

// A response with past hours, the current partial hour and a future hour.
$recent = WeatherClient::completedHours(WeatherClient::parseHourly([
    'hourly' => [
        'time'           => ['2026-11-09T17:00', '2026-11-09T18:00', '2026-11-09T19:00', '2026-11-09T20:00', '2026-11-09T21:00'],
        'temperature_2m' => [1.0, 1.5, 2.0, 2.5, 3.0],
        'precipitation'  => [0.1, 0.2, 0.3, 0.4, 0.5],
        'snowfall'       => [0.0, 0.0, 0.0, 0.0, 0.0],
        'weather_code'   => [3, 3, 3, 3, 3],
    ],
]), '2026-11-09 20:00:00');

$bad = false;
try {
    WeatherClient::parseCurrent(['nope' => 1]);
} catch (WeatherException) {
    $bad = true;
}

$checks = [
    'current observedAt floored to hour' => $cur['observedAt'] === '2026-11-09 20:00:00',
    'current values'                     => $cur['temperature'] === 3.5 && $cur['precipitation'] === 0.2 && $cur['weatherCode'] === 61,
    'hourly skips future empty hour'     => count($hourly) === 2,
    'hourly row values'                  => $hourly[1]['snowfall'] === 0.3 && $hourly[1]['weatherCode'] === 71,
    'missing block throws'               => $bad,
    'only completed hours kept'          => array_column($recent, 'observedAt') === ['2026-11-09 17:00:00', '2026-11-09 18:00:00', '2026-11-09 19:00:00'],
    'completed hours keep hourly sums'   => $recent[2]['precipitation'] === 0.3,
];

$failures = 0;
foreach ($checks as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}\n";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
