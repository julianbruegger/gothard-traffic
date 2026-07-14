<?php

declare(strict_types=1);

/**
 * export-history.php — turn the accumulated gotthard_snapshots into a forecast.
 *
 * The cron (fetch-traffic.php) has been inserting one snapshot per run into
 * gotthard_snapshots with no retention limit, so the table is a full historical
 * record of observed tunnel queues/waits. This script:
 *
 *   1. Reports coverage (date range, row count, days, congestion events).
 *   2. Aggregates every snapshot into weekday × local-hour profiles for both
 *      portals — the data-driven replacement for the hand-tuned curves in
 *      site/src/lib/forecast.ts.
 *   3. Writes two JSON files next to the other data files:
 *        data/history-export.json   — raw rows (for offline model work)
 *        data/history-profiles.json — aggregated weekday × hour profiles
 *
 * Usage (on the server, via SSH):
 *   php cron/export-history.php            # summary + write both JSON files
 *   php cron/export-history.php --summary  # summary only, write nothing
 *   php cron/export-history.php --raw      # also include raw rows in export
 *
 * All timestamps in the DB are UTC; profiles are bucketed by Europe/Zurich
 * local time so they line up with the forecast model and real travel behaviour.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit('Forbidden: run this script via CLI, not over HTTP.');
}

require __DIR__ . '/../lib/Db.php';

$summaryOnly = in_array('--summary', $argv, true);
$includeRaw  = in_array('--raw', $argv, true);

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing config.php. Copy config.example.php to config.php and fill in your credentials.\n");
    exit(1);
}
/** @var array $config */
$config  = require $configPath;
$dataDir = $config['data_dir'] ?? __DIR__ . '/../data';

try {
    $pdo = Db::connect($config);
} catch (Throwable $e) {
    fwrite(STDERR, 'Database unavailable: ' . $e->getMessage() . "\n");
    exit(1);
}

// ─── Coverage ────────────────────────────────────────────────────────────────

$cov = $pdo->query(
    'SELECT COUNT(*)          AS rows_total,
            MIN(fetched_at)   AS first_at,
            MAX(fetched_at)   AS last_at,
            SUM(CASE WHEN north_queue_km > 0 OR south_queue_km > 0 THEN 1 ELSE 0 END) AS jam_rows
       FROM gotthard_snapshots'
)->fetch();

$rowsTotal = (int) ($cov['rows_total'] ?? 0);
if ($rowsTotal === 0) {
    fwrite(STDERR, "gotthard_snapshots is empty — the cron has not collected anything yet.\n");
    exit(1);
}

$firstAt = new DateTimeImmutable((string) $cov['first_at'], new DateTimeZone('UTC'));
$lastAt  = new DateTimeImmutable((string) $cov['last_at'],  new DateTimeZone('UTC'));
$spanDays = max(1, (int) ceil(($lastAt->getTimestamp() - $firstAt->getTimestamp()) / 86400));

fwrite(STDOUT, "── gotthard_snapshots coverage ──────────────────────────────\n");
fwrite(STDOUT, sprintf("  rows:            %s\n", number_format($rowsTotal)));
fwrite(STDOUT, sprintf("  first snapshot:  %s UTC\n", $firstAt->format('Y-m-d H:i')));
fwrite(STDOUT, sprintf("  last snapshot:   %s UTC\n", $lastAt->format('Y-m-d H:i')));
fwrite(STDOUT, sprintf("  span:            ~%d day(s)\n", $spanDays));
fwrite(STDOUT, sprintf("  rows with a jam: %s (%.1f%%)\n",
    number_format((int) $cov['jam_rows']),
    100 * (int) $cov['jam_rows'] / $rowsTotal));
fwrite(STDOUT, sprintf("  avg cadence:     ~%.1f min between rows\n\n",
    ($lastAt->getTimestamp() - $firstAt->getTimestamp()) / 60 / max(1, $rowsTotal - 1)));

// ─── Aggregate into weekday × local-hour profiles ────────────────────────────

$zurich = new DateTimeZone('Europe/Zurich');

// buckets[dir][weekday 0-6][hour 0-23] = ['waitSum','waitMax','kmSum','n','jamN']
$buckets = [];
foreach (['north', 'south'] as $dir) {
    for ($w = 0; $w < 7; $w++) {
        for ($h = 0; $h < 24; $h++) {
            $buckets[$dir][$w][$h] = ['waitSum' => 0.0, 'waitMax' => 0, 'kmSum' => 0.0, 'n' => 0, 'jamN' => 0];
        }
    }
}

$rawRows = [];

$stmt = $pdo->query(
    'SELECT fetched_at,
            north_queue_km, north_wait_min,
            south_queue_km, south_wait_min
       FROM gotthard_snapshots
      ORDER BY fetched_at ASC'
);

while ($row = $stmt->fetch()) {
    $utc   = new DateTimeImmutable((string) $row['fetched_at'], new DateTimeZone('UTC'));
    $local = $utc->setTimezone($zurich);
    $w = (int) $local->format('w'); // 0 = Sunday
    $h = (int) $local->format('G'); // 0-23

    foreach (['north', 'south'] as $dir) {
        $wait = $row["{$dir}_wait_min"] !== null ? (int) $row["{$dir}_wait_min"] : 0;
        $km   = $row["{$dir}_queue_km"] !== null ? (float) $row["{$dir}_queue_km"] : 0.0;
        $b = &$buckets[$dir][$w][$h];
        $b['waitSum'] += $wait;
        $b['waitMax']  = max($b['waitMax'], $wait);
        $b['kmSum']   += $km;
        $b['n']++;
        if ($km > 0 || $wait > 0) {
            $b['jamN']++;
        }
        unset($b);
    }

    if ($includeRaw && !$summaryOnly) {
        $rawRows[] = [
            't'                => $utc->format(DateTimeInterface::ATOM),
            'northQueueKm'     => $row['north_queue_km'] !== null ? (float) $row['north_queue_km'] : null,
            'southQueueKm'     => $row['south_queue_km'] !== null ? (float) $row['south_queue_km'] : null,
            'northWaitMinutes' => $row['north_wait_min'] !== null ? (int) $row['north_wait_min'] : null,
            'southWaitMinutes' => $row['south_wait_min'] !== null ? (int) $row['south_wait_min'] : null,
        ];
    }
}

// Build the profile structure: per direction, 7 weekdays × 24 hours of stats.
$profiles = ['generated' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM)];
foreach (['north', 'south'] as $dir) {
    for ($w = 0; $w < 7; $w++) {
        for ($h = 0; $h < 24; $h++) {
            $b = $buckets[$dir][$w][$h];
            $profiles[$dir][$w][$h] = [
                'avgWait' => $b['n'] > 0 ? round($b['waitSum'] / $b['n'], 1) : 0.0,
                'maxWait' => $b['waitMax'],
                'avgKm'   => $b['n'] > 0 ? round($b['kmSum'] / $b['n'], 2) : 0.0,
                'jamRate' => $b['n'] > 0 ? round($b['jamN'] / $b['n'], 3) : 0.0,
                'samples' => $b['n'],
            ];
        }
    }
}

// ─── Peak-hour readout (the useful bit to eyeball) ───────────────────────────

$dayNames = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
fwrite(STDOUT, "── busiest hour per weekday (avg wait, both portals) ─────────\n");
for ($w = 0; $w < 7; $w++) {
    $bestN = ['h' => 0, 'v' => -1];
    $bestS = ['h' => 0, 'v' => -1];
    for ($h = 0; $h < 24; $h++) {
        if ($profiles['north'][$w][$h]['avgWait'] > $bestN['v']) $bestN = ['h' => $h, 'v' => $profiles['north'][$w][$h]['avgWait']];
        if ($profiles['south'][$w][$h]['avgWait'] > $bestS['v']) $bestS = ['h' => $h, 'v' => $profiles['south'][$w][$h]['avgWait']];
    }
    fwrite(STDOUT, sprintf(
        "  %s   N→ %02d:00 (%4.1f min)   S→ %02d:00 (%4.1f min)\n",
        $dayNames[$w], $bestN['h'], $bestN['v'], $bestS['h'], $bestS['v']
    ));
}
fwrite(STDOUT, "\n");

if ($summaryOnly) {
    fwrite(STDOUT, "--summary given: no files written.\n");
    exit(0);
}

// ─── Write outputs ───────────────────────────────────────────────────────────

if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0775, true);
}

$profilesPath = $dataDir . '/history-profiles.json';
file_put_contents($profilesPath, json_encode($profiles, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
fwrite(STDOUT, "Wrote {$profilesPath}\n");

if ($includeRaw) {
    $exportPath = $dataDir . '/history-export.json';
    file_put_contents($exportPath, json_encode([
        'generated' => (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM),
        'source'    => 'gotthard_snapshots (opentransportdata.swiss / ASTRA)',
        'rows'      => $rawRows,
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    fwrite(STDOUT, sprintf("Wrote %s (%s rows)\n", $exportPath, number_format(count($rawRows))));
}

fwrite(STDOUT, "\nDone. Copy history-profiles.json into the repo to recalibrate forecast.ts.\n");
