<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=300');
header('Access-Control-Allow-Origin: *');

const STATS_CACHE_TTL = 900; // 15 min

$cacheFile = __DIR__ . '/../data/stats-cache.json';
$lockFile  = __DIR__ . '/../data/stats-cache.lock';

$cacheFresh = static fn (): bool => is_file($cacheFile) && (time() - (int) filemtime($cacheFile)) < STATS_CACHE_TTL;

if ($cacheFresh()) {
    readfile($cacheFile);
    exit;
}

// Only one request recomputes at a time. Others serve the stale cache if there
// is one, otherwise wait for the lock and then read the fresh cache.
if (!is_dir(dirname($lockFile))) {
    @mkdir(dirname($lockFile), 0775, true);
}
$lock = @fopen($lockFile, 'c');
$locked = false;
if ($lock !== false) {
    $locked = flock($lock, LOCK_EX | LOCK_NB);
    if (!$locked) {
        if (is_file($cacheFile)) {
            readfile($cacheFile);
            exit;
        }
        $locked = flock($lock, LOCK_EX); // wait for the recomputing request
        clearstatcache(true, $cacheFile);
        if ($cacheFresh()) {
            readfile($cacheFile);
            exit;
        }
    }
}

$configPath = __DIR__ . '/../cron/config.php';
if (!is_file($configPath)) {
    http_response_code(503);
    echo json_encode(['error' => 'Server not configured.']);
    exit;
}
$config = require $configPath;

require_once __DIR__ . '/../lib/Db.php';
require_once __DIR__ . '/../lib/SnapshotStore.php';
require_once __DIR__ . '/../lib/StatsCalculator.php';
require_once __DIR__ . '/../lib/WeatherStore.php';

try {
    $pdo   = Db::connect($config);
    $calc  = new StatsCalculator();
    foreach ((new SnapshotStore($pdo))->iterateStatsRows(365) as $row) {
        $calc->add($row);
    }
    // Weather history is optional: the table may not exist yet.
    $weather = [];
    try {
        $weather = (new WeatherStore($pdo))->history(365);
    } catch (Throwable $e) {
        $weather = [];
    }
    $stats = $calc->finish(null, $weather);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Database unavailable.']);
    exit;
}

$json = json_encode($stats, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
if (!is_dir(dirname($cacheFile))) {
    @mkdir(dirname($cacheFile), 0775, true);
}
$tmp = $cacheFile . '.' . getmypid() . '.tmp';
if (@file_put_contents($tmp, $json) !== false) {
    @rename($tmp, $cacheFile);
}
echo $json;
