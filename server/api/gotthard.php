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
    $row   = $store->latest();
} catch (Throwable $e) {
    http_response_code(503);
    echo json_encode(['error' => 'Database unavailable.']);
    exit;
}

if ($row === null) {
    http_response_code(404);
    echo json_encode(['error' => 'No data yet — cron job has not run yet.']);
    exit;
}

$updatedAt = (new DateTimeImmutable($row['fetched_at'], new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);

$data = [
    'updated' => $updatedAt,
    'source'  => 'opentransportdata.swiss (ASTRA Traffic Situations)',
    'tunnel'  => [
        'status' => $row['tunnel_status'],
        'north'  => [
            'queueKm'     => $row['north_queue_km'] !== null ? (float) $row['north_queue_km'] : null,
            'waitMinutes' => $row['north_wait_min'] !== null ? (int)   $row['north_wait_min'] : null,
            'cause'       => $row['north_cause'],
            'closures'    => [],
        ],
        'south'  => [
            'queueKm'     => $row['south_queue_km'] !== null ? (float) $row['south_queue_km'] : null,
            'waitMinutes' => $row['south_wait_min'] !== null ? (int)   $row['south_wait_min'] : null,
            'cause'       => $row['south_cause'],
            'closures'    => [],
        ],
        'plannedClosures' => isset($row['planned_closures']) && $row['planned_closures'] !== null
            ? (json_decode($row['planned_closures'], true) ?: [])
            : [],
    ],
    'pass' => [
        'status' => $row['pass_status'],
        'note'   => $row['pass_note'],
    ],
];

echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
