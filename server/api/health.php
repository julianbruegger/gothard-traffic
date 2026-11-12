<?php

declare(strict_types=1);

// Minimal health endpoint for an external uptime monitor. Exposes only whether
// the collector succeeded recently - never error text. HTTP 503 when stale.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

$config = [];
$configPath = __DIR__ . '/../cron/config.php';
if (is_file($configPath)) {
    $config = require $configPath;
}

$statePath = $config['state_file'] ?? __DIR__ . '/../data/collector-state.json';
$maxAgeMin = (int) ($config['health_max_age_minutes'] ?? 15);

$raw   = is_file($statePath) ? @file_get_contents($statePath) : false;
$state = is_string($raw) ? json_decode($raw, true) : null;
$lastSuccess = is_array($state) ? ($state['lastSuccess'] ?? null) : null;

$ok = false;
if (is_string($lastSuccess)) {
    $ts = strtotime($lastSuccess);
    $ok = $ts !== false && (time() - $ts) <= $maxAgeMin * 60;
}

if (!$ok) {
    http_response_code(503);
}
echo json_encode(['ok' => $ok, 'lastSuccess' => $lastSuccess], JSON_UNESCAPED_SLASHES);
