<?php

declare(strict_types=1);

require __DIR__ . '/../lib/TrafficParser.php';

$config = require __DIR__ . '/../config.example.php';
$xml = file_get_contents(__DIR__ . '/sample-datex2.xml');

$parser = new TrafficParser($config);
$result = $parser->parse($xml);

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";

$assertions = [
    'tunnel.status == congested'         => $result['tunnel']['status'] === 'congested',
    'north.queueKm == 2.0'               => $result['tunnel']['north']['queueKm'] === 2.0,
    'north.waitMinutes == 20'            => $result['tunnel']['north']['waitMinutes'] === 20,
    'north.cause == Verkehrsüberlastung' => $result['tunnel']['north']['cause'] === 'Verkehrsüberlastung',
    'south.queueKm == 1.0'               => $result['tunnel']['south']['queueKm'] === 1.0,
    'south.waitMinutes == 10'            => $result['tunnel']['south']['waitMinutes'] === 10,
    'pass.status == restricted'          => $result['pass']['status'] === 'restricted',
    // NORTH + SOUTH + PASS only — works, leaked street, Ticino Stau and the
    // expired closure are all excluded.
    'debug matched 3 records'            => count($result['debug']) === 3,
];

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? "PASS" : "FAIL") . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}

exit($failures > 0 ? 1 : 0);
