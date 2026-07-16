<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=55');
header('Access-Control-Allow-Origin: *');

$configPath = __DIR__ . '/../cron/config.php';
if (!is_file($configPath)) {
    http_response_code(503);
    echo json_encode(['error' => 'Server not configured.']);
    exit;
}
$config = require $configPath;

require_once __DIR__ . '/../lib/Db.php';
require_once __DIR__ . '/../lib/SnapshotStore.php';

try {
    $pdo   = Db::connect($config);
    $store = new SnapshotStore($pdo);
    $rows  = $store->history(48);
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Database unavailable.']);
    exit;
}

$tz = new DateTimeZone('UTC');

$points = array_map(static function (array $row) use ($tz): array {
    return [
        't'                => (new DateTimeImmutable($row['fetched_at'], $tz))->format(DateTimeInterface::ATOM),
        'northQueueKm'     => $row['north_queue_km'] !== null ? (float) $row['north_queue_km'] : null,
        'southQueueKm'     => $row['south_queue_km'] !== null ? (float) $row['south_queue_km'] : null,
        'northWaitMinutes' => $row['north_wait_min'] !== null ? (int)   $row['north_wait_min'] : null,
        'southWaitMinutes' => $row['south_wait_min'] !== null ? (int)   $row['south_wait_min'] : null,
        'status'           => $row['tunnel_status'] ?? 'unknown',
    ];
}, $rows);

echo json_encode($points, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
