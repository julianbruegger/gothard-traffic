<?php

declare(strict_types=1);

// Guard against this script being reachable over HTTP - it's meant to be
// invoked by a cron job (`php fetch-traffic.php`) only.
if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden: run this script via CLI/cron, not over HTTP.');
}

require __DIR__ . '/lib/DatexClient.php';
require __DIR__ . '/lib/TrafficParser.php';
require __DIR__ . '/../lib/Db.php';
require __DIR__ . '/../lib/SnapshotStore.php';

$debug = in_array('--debug', $argv, true);

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing config.php. Copy config.example.php to config.php and fill in your credentials.\n");
    exit(1);
}
/** @var array $config */
$config = require $configPath;

$errorLogPath = $config['error_log'] ?? __DIR__ . '/../data/fetch-error.log';

function iso_now(): string
{
    return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
}

try {
    $client = new DatexClient($config);
    $xml    = $client->fetchRaw();

    $parser = new TrafficParser($config);
    $result = $parser->parse($xml);

    if ($debug) {
        fwrite(STDOUT, 'Matched ' . count($result['debug']) . " record(s):\n");
        foreach ($result['debug'] as $i => $rawXml) {
            fwrite(STDOUT, "\n--- record " . ($i + 1) . " ---\n{$rawXml}\n");
        }
    }

    $now = iso_now();

    $pdo   = Db::connect($config);
    $store = new SnapshotStore($pdo);
    $store->insert($result, $now);

    fwrite(STDOUT, "[{$now}] OK — north " . ($result['tunnel']['north']['queueKm'] ?? 0) . ' km'
        . ', south ' . ($result['tunnel']['south']['queueKm'] ?? 0) . " km\n");
} catch (Throwable $e) {
    $message = $e->getMessage();
    fwrite(STDERR, "fetch-traffic.php failed: {$message}\n");

    $logDir = dirname($errorLogPath);
    if (!is_dir($logDir)) {
        @mkdir($logDir, 0775, true);
    }
    @file_put_contents($errorLogPath, '[' . iso_now() . "] {$message}\n", FILE_APPEND);

    exit(1);
}
