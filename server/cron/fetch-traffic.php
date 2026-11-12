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
require __DIR__ . '/lib/CollectorState.php';
require __DIR__ . '/lib/IndexNow.php';
require __DIR__ . '/../lib/Db.php';
require __DIR__ . '/../lib/SnapshotStore.php';
require __DIR__ . '/../lib/SnapshotMapper.php';
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

$dataDir   = dirname($errorLogPath);
$statePath = $config['state_file'] ?? __DIR__ . '/../data/collector-state.json';

/** Send a plain-text alert mail to the optional alert_email (non-fatal). */
function send_alert(array $config, string $subject, string $body): void
{
    $to = $config['alert_email'] ?? '';
    if ($to === '') {
        return;
    }
    $headers = isset($config['alert_from']) && $config['alert_from'] !== ''
        ? 'From: ' . $config['alert_from'] : '';
    @mail($to, '[gotthard-traffic] ' . $subject, $body, $headers);
}

// One-off repair (#52): older live weather rows hold 15-minute sums labelled as
// hours. Re-run `php cron/fetch-traffic.php --backfill-weather` once to
// overwrite the last 90 days with real hourly sums.
// `php fetch-traffic.php --backfill-weather` loads the last 90 days of
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

// Run lock: the cron fires every ~3 min but a run can take up to ~50 s when an
// upstream hangs. If the previous run is still going, exit quietly.
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0775, true);
}
$lockHandle = @fopen($dataDir . '/fetch.lock', 'c');
if ($lockHandle !== false && !flock($lockHandle, LOCK_EX | LOCK_NB)) {
    exit(0);
}

CollectorState::rotateLog($errorLogPath);
$state = new CollectorState($statePath);

try {
    $client = new DatexClient($config);
    $xml    = $client->fetchRaw();

    $parser = new TrafficParser($config);
    $result = $parser->parse($xml);
    // Refuse an empty / partial feed instead of storing it as "free traffic".
    TrafficParser::assertFeedSane($result, $config);

    if ($debug) {
        fwrite(STDOUT, 'Matched ' . count($result['debug']) . " record(s):\n");
        foreach ($result['debug'] as $i => $rawXml) {
            fwrite(STDOUT, "\n--- record " . ($i + 1) . " ---\n{$rawXml}\n");
        }
    }

    // Secondary, advisory source for the PASS status (alpen-paesse.ch). DATEX
    // (official ASTRA) stays authoritative; this only fills the pass status when
    // DATEX carries no pass record (e.g. summer, pass simply open). Non-fatal.
    $result['pass']['source'] = $result['pass']['status'] !== 'unknown' ? 'datex' : null;
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
                    // Note stays null: it was German-only. The client renders
                    // "Source: alpen-paesse.ch" from pass_source in both languages.
                    $result['pass']['source'] = 'alpen-paesse.ch';
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

    // IndexNow (optional): the previous snapshot is the change baseline on the
    // first run. Never let it affect the snapshot itself.
    $indexNowKey = trim((string) ($config['indexnow_key'] ?? (getenv('INDEXNOW_KEY') ?: '')));
    $previous = null;
    if ($indexNowKey !== '') {
        try {
            $previousRow = $store->latest();
            $previous = $previousRow !== null ? SnapshotMapper::fromRow($previousRow) : null;
        } catch (Throwable) {
            $previous = null;
        }
    }

    $store->insert($result, $now);

    // Hourly weather history (advisory, non-fatal): never let a weather problem
    // or a not-yet-migrated table stop the traffic snapshot above.
    if (($config['weather_enabled'] ?? true)) {
        try {
            $weatherStore = new WeatherStore($pdo);
            // Upsert the last completed hours every run (idempotent): late model
            // corrections overwrite earlier values and a missed hour gets filled.
            $n = 0;
            foreach ((new WeatherClient($config))->fetchRecentHours(3) as $portal => $rows) {
                foreach ($rows as $w) {
                    $weatherStore->upsert($portal, $w);
                    $n++;
                }
            }
            if ($debug) {
                fwrite(STDOUT, "Weather upserted: {$n} portal-hour(s).\n");
            }
        } catch (Throwable $e) {
            @file_put_contents($errorLogPath, '[' . iso_now() . '] weather: ' . $e->getMessage() . "\n", FILE_APPEND);
            if ($debug) {
                fwrite(STDOUT, 'Weather failed: ' . $e->getMessage() . "\n");
            }
        }
    }

    // Optional nightly retention: thin old rows to one per hour (opt-in).
    $retentionDays = (int) ($config['retention_days'] ?? 0);
    if ($retentionDays > 0 && gmdate('H') === '03' && $state->get('lastRetention') !== gmdate('Y-m-d')) {
        try {
            $thinned = $store->thinOlderThan($retentionDays);
            $state->set('lastRetention', gmdate('Y-m-d'));
            if ($debug) {
                fwrite(STDOUT, "Retention: thinned {$thinned} row(s) older than {$retentionDays} days.\n");
            }
        } catch (Throwable $e) {
            @file_put_contents($errorLogPath, '[' . iso_now() . '] retention: ' . $e->getMessage() . "\n", FILE_APPEND);
        }
    }

    // IndexNow ping when the tunnel status or the planned closures changed
    // (at most every 30 min). Writes <webroot>/<key>.txt if missing. Non-fatal.
    if ($indexNowKey !== '') {
        try {
            $indexNow = new IndexNow(
                $indexNowKey,
                (string) ($config['site_url'] ?? 'https://gotthard.jubr.app'),
                (string) ($config['indexnow_state_file'] ?? __DIR__ . '/../data/indexnow-state.json'),
            );
            if (!IndexNow::isValidKey($indexNowKey)) {
                throw new RuntimeException('invalid indexnow_key (8-128 characters a-z, A-Z, 0-9, "-")');
            }
            if (!$indexNow->ensureKeyFile(__DIR__ . '/..')) {
                throw new RuntimeException('could not write the key file to the web root');
            }
            $ping = $indexNow->maybePing($result, $previous, time());
            if ($ping === 'failed') {
                @file_put_contents($errorLogPath, '[' . iso_now() . "] indexnow: ping failed\n", FILE_APPEND);
            }
            if ($debug) {
                fwrite(STDOUT, "IndexNow: {$ping}\n");
            }
        } catch (Throwable $e) {
            @file_put_contents($errorLogPath, '[' . iso_now() . '] indexnow: ' . $e->getMessage() . "\n", FILE_APPEND);
        }
    }

    if ($state->recordSuccess($now)) {
        send_alert($config, 'collector recovered', "The collector is fetching successfully again as of {$now}.\n");
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

    $threshold = (int) ($config['alert_after_failures'] ?? 5);
    if ($state->recordFailure($message, $threshold)) {
        send_alert($config, 'collector failing',
            "The collector failed {$threshold} times in a row (about " . ($threshold * 3) . " min).\nLast error: {$message}\n");
    }

    exit(1);
}
