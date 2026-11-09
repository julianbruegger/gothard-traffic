<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=300');
header('Access-Control-Allow-Origin: *');

const STATS_CACHE_TTL = 900; // 15 min

$cacheFile = __DIR__ . '/../data/stats-cache.json';
if (is_file($cacheFile) && (time() - (int) filemtime($cacheFile)) < STATS_CACHE_TTL) {
    readfile($cacheFile);
    exit;
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
    $rows  = (new SnapshotStore($pdo))->statsRows(365);
    // Weather history is optional: the table may not exist yet.
    $weather = [];
    try {
        $weather = (new WeatherStore($pdo))->history(365);
    } catch (Throwable $e) {
        $weather = [];
    }
    $stats = (new StatsCalculator())->compute($rows, null, $weather);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Database unavailable.']);
    exit;
}

$json = json_encode($stats, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
if (!is_dir(dirname($cacheFile))) {
    @mkdir(dirname($cacheFile), 0775, true);
}
@file_put_contents($cacheFile, $json, LOCK_EX);
echo $json;
