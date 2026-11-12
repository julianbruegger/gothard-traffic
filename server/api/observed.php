<?php

declare(strict_types=1);

/**
 * Per-day hourly queue aggregate for the forecast model (same JSON shape as
 * site/src/data/observed-days.json). The site loads it at runtime and refits
 * the model in the browser, so the forecast always includes yesterday without
 * any manual export. Cached to a file for 1 h.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=600');
header('Access-Control-Allow-Origin: *');

const OBSERVED_CACHE_TTL = 3600; // 1 h
const OBSERVED_WINDOW_DAYS = 365;

$cacheFile = __DIR__ . '/../data/observed-cache.json';
if (is_file($cacheFile) && (time() - (int) filemtime($cacheFile)) < OBSERVED_CACHE_TTL) {
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
require_once __DIR__ . '/../lib/ObservedDays.php';

try {
    $pdo  = Db::connect($config);
    $rows = (new SnapshotStore($pdo))->observedRows(OBSERVED_WINDOW_DAYS);
    $data = ObservedDays::build($rows);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Database unavailable.']);
    exit;
}

$json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION);
if (!is_dir(dirname($cacheFile))) {
    @mkdir(dirname($cacheFile), 0775, true);
}
@file_put_contents($cacheFile, $json, LOCK_EX);
echo $json;
