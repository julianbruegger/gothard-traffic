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
require __DIR__ . '/lib/PassStatusClient.php';
require __DIR__ . '/lib/WeatherClient.php';
require __DIR__ . '/../lib/Db.php';
require __DIR__ . '/../lib/SnapshotStore.php';
require __DIR__ . '/../lib/WeatherStore.php';

$debug = in_array('--debug', $argv, true);
$backfillWeather = in_array('--backfill-weather', $argv, true);

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

// One-off: `php fetch-traffic.php --backfill-weather` loads the last 90 days of
// hourly weather (Open-Meteo keeps ~3 months) so history starts before the
// collector began storing it.
if ($backfillWeather) {
    try {
        $weatherStore = new WeatherStore(Db::connect($config));
        $n = 0;
        foreach ((new WeatherClient($config))->fetchHistory(90) as $portal => $rows) {
            foreach ($rows as $w) {
                $weatherStore->upsert($portal, $w);
                $n++;
            }
        }
        fwrite(STDOUT, "Backfilled {$n} weather rows.\n");
        exit(0);
    } catch (Throwable $e) {
        fwrite(STDERR, 'Weather backfill failed: ' . $e->getMessage() . "\n");
        exit(1);
    }
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

    // Secondary, advisory source for the PASS status (alpen-paesse.ch). DATEX
    // (official ASTRA) stays authoritative; this only fills the pass status when
    // DATEX carries no pass record (e.g. summer, pass simply open). Non-fatal.
    if (($config['pass_source_enabled'] ?? true)) {
        try {
            $second = (new PassStatusClient($config))->fetch();
            if ($second !== null) {
                if ($debug) {
                    fwrite(STDOUT, 'Pass 2nd source (alpen-paesse.ch): ' . json_encode($second, JSON_UNESCAPED_UNICODE) . "\n");
                }
                $datexStatus = $result['pass']['status'] ?? 'unknown';
                if ($datexStatus === 'unknown') {
                    $result['pass']['status'] = $second['status'];
                    if (empty($result['pass']['note'])) {
                        $result['pass']['note'] = $second['note'];
                    }
                } elseif ($debug && $datexStatus !== $second['status']) {
                    fwrite(STDOUT, "  note: pass status differs — DATEX={$datexStatus}, alpen-paesse={$second['status']}\n");
                }
            }
        } catch (Throwable $e) {
            if ($debug) {
                fwrite(STDOUT, 'Pass 2nd source failed: ' . $e->getMessage() . "\n");
            }
        }
    }

    $now = iso_now();

    $pdo   = Db::connect($config);
    $store = new SnapshotStore($pdo);
    $store->insert($result, $now);

    // Hourly weather history (advisory, non-fatal): never let a weather problem
    // or a not-yet-migrated table stop the traffic snapshot above.
    if (($config['weather_enabled'] ?? true)) {
        try {
            $weatherStore = new WeatherStore($pdo);
            $hour = gmdate('Y-m-d H:00:00');
            if (!$weatherStore->hasHour($hour)) {
                foreach ((new WeatherClient($config))->fetchCurrent() as $portal => $w) {
                    $weatherStore->upsert($portal, $w);
                }
                if ($debug) {
                    fwrite(STDOUT, "Weather stored for {$hour}.\n");
                }
            }
        } catch (Throwable $e) {
            @file_put_contents($errorLogPath, '[' . iso_now() . '] weather: ' . $e->getMessage() . "\n", FILE_APPEND);
            if ($debug) {
                fwrite(STDOUT, 'Weather failed: ' . $e->getMessage() . "\n");
            }
        }
    }

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
