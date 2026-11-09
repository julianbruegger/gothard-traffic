<?php

declare(strict_types=1);

require __DIR__ . '/../lib/TrafficParser.php';

// A <= 1 km south queue whose situationRecordVersionTime is years old must be ignored.
$config = require __DIR__ . '/../config.example.php';
$xml = file_get_contents(__DIR__ . '/sample-stale.xml');
$result = (new TrafficParser($config))->parse($xml);

$ok = $result['tunnel']['south']['queueKm'] === null
    && $result['tunnel']['north']['queueKm'] === 2.0;
echo ($ok ? 'PASS' : 'FAIL') . ": stale 1 km south queue ignored, north kept\n";
exit($ok ? 0 : 1);
