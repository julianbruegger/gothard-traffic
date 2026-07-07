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
require __DIR__ . '/lib/JsonStore.php';
require __DIR__ . '/lib/HistoryStore.php';

$debug = in_array('--debug', $argv, true);

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing config.php. Copy config.example.php to config.php and add your API token.\n");
    exit(1);
}
/** @var array $config */
$config = require $configPath;

$dataDir = rtrim((string) ($config['data_dir'] ?? __DIR__ . '/../data'), '/');
$gotthardPath = $dataDir . '/gotthard.json';
$historyPath = $dataDir . '/history.json';
$errorLogPath = $dataDir . '/fetch-error.log';

function iso_now(): string
{
    return (new DateTimeImmutable('now'))->format(DateTimeInterface::ATOM);
}

function write_fallback(string $gotthardPath, array $config, string $reason): void
{
    $fallback = [
        'updated' => iso_now(),
        'source' => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel' => [
            'status' => 'unknown',
            'north' => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null],
            'south' => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null],
        ],
        'pass' => ['status' => 'unknown', 'note' => null],
        'error' => $reason,
    ];
    JsonStore::write($gotthardPath, $fallback);
}

try {
    $client = new DatexClient($config);
    $xml = $client->fetchRaw();

    $parser = new TrafficParser($config);
    $result = $parser->parse($xml);

    if ($debug) {
        fwrite(STDOUT, "Matched " . count($result['debug']) . " record(s):\n");
        foreach ($result['debug'] as $i => $rawXml) {
            fwrite(STDOUT, "\n--- record " . ($i + 1) . " ---\n{$rawXml}\n");
        }
    }

    $now = iso_now();
    $output = [
        'updated' => $now,
        'source' => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel' => $result['tunnel'],
        'pass' => $result['pass'],
    ];
    JsonStore::write($gotthardPath, $output);

    $history = new HistoryStore(
        $historyPath,
        (int) ($config['history_retention_hours'] ?? 48),
        (int) ($config['history_min_interval_minutes'] ?? 10),
    );
    $history->append([
        't' => $now,
        'northQueueKm' => $result['tunnel']['north']['queueKm'],
        'southQueueKm' => $result['tunnel']['south']['queueKm'],
        'northWaitMinutes' => $result['tunnel']['north']['waitMinutes'],
        'southWaitMinutes' => $result['tunnel']['south']['waitMinutes'],
    ]);

    fwrite(STDOUT, "OK: wrote " . $gotthardPath . " at {$now}\n");
} catch (Throwable $e) {
    $message = $e->getMessage();
    fwrite(STDERR, "fetch-traffic.php failed: {$message}\n");
    @file_put_contents($errorLogPath, "[" . iso_now() . "] {$message}\n", FILE_APPEND);
    write_fallback($gotthardPath, $config, $message);
    exit(1);
}
