<?php

declare(strict_types=1);

/**
 * Deployed to the web root alongside the static Astro build (index.html,
 * _astro/, robots.txt, ...). Most PHP hosts default to serving index.php
 * before index.html when both exist (Apache DirectoryIndex "index.php
 * index.html"), so this becomes the actual entry point for "/", while
 * index.html itself is kept as the template this script reads and enriches.
 *
 * This keeps the site static-hostable (works with zero PHP too - you'd just
 * get index.html with no live SSR data) while adding real server-rendered
 * content for crawlers whenever PHP *is* available, which it is here.
 */

require_once __DIR__ . '/lib/I18n.php';
require_once __DIR__ . '/lib/Format.php';
require_once __DIR__ . '/lib/Ssr.php';
require_once __DIR__ . '/lib/Db.php';
require_once __DIR__ . '/lib/SnapshotStore.php';

function ssr_default_data(): array
{
    return [
        'updated' => null,
        'source'  => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel'  => [
            'status' => 'unknown',
            'closureReason' => null,
            'closureUntil' => null,
            'north'  => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null, 'closures' => []],
            'south'  => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null, 'closures' => []],
        ],
        'pass' => ['status' => 'unknown', 'note' => null],
    ];
}

function row_to_data(array $row): array
{
    $updatedAt = (new DateTimeImmutable($row['fetched_at'], new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);
    return [
        'updated' => $updatedAt,
        'source'  => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel'  => [
            'status' => $row['tunnel_status'],
            'closureReason' => $row['closure_reason'] ?? null,
            'closureUntil' => !empty($row['closure_until'])
                ? (new DateTimeImmutable($row['closure_until'], new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM)
                : null,
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
        ],
        'pass' => [
            'status' => $row['pass_status'],
            'note'   => $row['pass_note'],
        ],
    ];
}

$templatePath = __DIR__ . '/index.html';
if (!is_file($templatePath)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Site not deployed yet: index.html is missing (deploy the Astro build output alongside this file).";
    exit;
}

$lang = $_GET['lang'] ?? $_GET['lan'] ?? 'de';
if (!I18n::isSupported($lang)) {
    $lang = 'de';
}

$data = ssr_default_data();

$configPath = __DIR__ . '/cron/config.php';
if (is_file($configPath)) {
    try {
        $config = require $configPath;
        $pdo    = Db::connect($config);
        $store  = new SnapshotStore($pdo);
        $row    = $store->latest();
        if ($row !== null) {
            $data = row_to_data($row);
        }
    } catch (Throwable) {
        // Fall through to default data — DB unavailable or not yet configured.
    }
}

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
$path   = strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
$base   = "{$scheme}://{$host}" . rtrim((string) $path, '/');
$canonicalUrl = $lang === 'de' ? ($base === '' ? '/' : $base . '/') : $base . '/?lang=en';

$template = (string) file_get_contents($templatePath);
$html     = Ssr::render($template, $data, $lang, $canonicalUrl);

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=60');
if (!empty($data['updated'])) {
    $lastModified = strtotime((string) $data['updated']);
    if ($lastModified !== false) {
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $lastModified) . ' GMT');
    }
}
echo $html;
