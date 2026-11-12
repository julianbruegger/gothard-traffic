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
require_once __DIR__ . '/lib/SnapshotMapper.php';

function ssr_default_data(): array
{
    return [
        'updated' => null,
        'source'  => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel'  => [
            'status' => 'unknown',
            'closureReason' => null,
            'north'  => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null, 'closures' => []],
            'south'  => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null, 'closures' => []],
        ],
        'pass' => ['status' => 'unknown', 'note' => null],
    ];
}

$lang = $_GET['lang'] ?? $_GET['lan'] ?? 'de';
if (!is_string($lang) || !I18n::isSupported($lang)) {
    $lang = 'de';
}

// German is the Astro "index" page, English the flat en.html (served at /en).
$templatePath = __DIR__ . '/' . ($lang === 'en' ? 'en.html' : 'index.html');
if (!is_file($templatePath)) {
    http_response_code(503);
    header('Content-Type: text/plain; charset=utf-8');
    echo "Site not deployed yet: " . basename($templatePath) . " is missing (deploy the Astro build output alongside this file).";
    exit;
}

$data = ssr_default_data();
$siteUrl = 'https://gotthard.jubr.app';

$configPath = __DIR__ . '/cron/config.php';
if (is_file($configPath)) {
    try {
        $config = require $configPath;
        $siteUrl = is_array($config) ? ($config['site_url'] ?? $siteUrl) : $siteUrl;
        $pdo    = Db::connect($config);
        $store  = new SnapshotStore($pdo);
        $row    = $store->latest();
        if ($row !== null) {
            $data = SnapshotMapper::fromRow($row);
        }
    } catch (Throwable) {
        // Fall through to default data — DB unavailable or not yet configured.
    }
}

// Canonical comes from a fixed base (never HTTP_HOST / REQUEST_URI): "<base>/" for de, "<base>/en" for en.
$siteUrl      = rtrim((string) $siteUrl, '/');
$canonicalUrl = $lang === 'en' ? $siteUrl . '/en' : $siteUrl . '/';

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
