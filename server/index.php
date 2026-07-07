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

function ssr_default_data(): array
{
    return [
        'updated' => null,
        'source' => 'opentransportdata.swiss (ASTRA Traffic Situations)',
        'tunnel' => [
            'status' => 'unknown',
            'north' => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null],
            'south' => ['queueKm' => null, 'waitMinutes' => null, 'cause' => null],
        ],
        'pass' => ['status' => 'unknown', 'note' => null],
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

$dataPath = __DIR__ . '/data/gotthard.json';
$data = ssr_default_data();
if (is_file($dataPath)) {
    $decoded = json_decode((string) file_get_contents($dataPath), true);
    if (is_array($decoded)) {
        $data = array_replace_recursive($data, $decoded);
    }
}

$scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
$host = $_SERVER['HTTP_HOST'] ?? 'localhost';
$path = strtok($_SERVER['REQUEST_URI'] ?? '/', '?');
$base = "{$scheme}://{$host}" . rtrim((string) $path, '/');
$canonicalUrl = $lang === 'de' ? ($base === '' ? '/' : $base . '/') : $base . '/?lang=en';

$template = (string) file_get_contents($templatePath);
$html = Ssr::render($template, $data, $lang, $canonicalUrl);

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=60');
if (!empty($data['updated'])) {
    $lastModified = strtotime((string) $data['updated']);
    if ($lastModified !== false) {
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $lastModified) . ' GMT');
    }
}
echo $html;
