<?php

declare(strict_types=1);

require __DIR__ . '/../lib/TrafficParser.php';

$config = require __DIR__ . '/../config.example.php';
$xml = file_get_contents(__DIR__ . '/sample-datex2.xml');

$parser = new TrafficParser($config);
$result = $parser->parse($xml);

echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";

$assertions = [
    'tunnel.status == congested' => $result['tunnel']['status'] === 'congested',
    'north.queueKm == 4.5' => $result['tunnel']['north']['queueKm'] === 4.5,
    'north.waitMinutes == 45' => $result['tunnel']['north']['waitMinutes'] === 45,
    'south.queueKm == null' => $result['tunnel']['south']['queueKm'] === null,
    'pass.status == open' => $result['pass']['status'] === 'open',
    'debug matched 2 records (not the A13 one)' => count($result['debug']) === 2,
];

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? "PASS" : "FAIL") . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}

exit($failures > 0 ? 1 : 0);
