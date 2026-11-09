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
];

$failures = 0;
foreach ($checks as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}\n";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
