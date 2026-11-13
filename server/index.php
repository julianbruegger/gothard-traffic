<?php

declare(strict_types=1);

/**
 * Front controller for every HTML page. Deployed to the web root alongside the
 * static Astro build (index.html, en.html, forecasts.html, en/forecasts.html,
 * _astro/, ...). .htaccess rewrites every extensionless URL whose .html exists
 * to index.php?page=<path> ("/" and "/en" included); this script reads that
 * built page as a template and fills its live markers (see lib/Ssr.php) before
 * sending it, so crawlers and AI fetchers (no JavaScript) get current content.
 *
 * The site stays static-hostable: without PHP the plain .html files are served
 * with their build-time fallback content.
 *
 * Query parameters (set by .htaccess, never by links):
 *   page  "forecasts", "en/forecasts", "en", ... (empty = German home)
 *   lang  legacy alias: lang=en without page = English home
 */

require_once __DIR__ . '/lib/I18n.php';
require_once __DIR__ . '/lib/Format.php';
require_once __DIR__ . '/lib/Ssr.php';
require_once __DIR__ . '/lib/ForecastTable.php';
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

function ssr_redirect(string $location): never
{
    header('Location: ' . $location, true, 301);
    header('Cache-Control: public, max-age=3600');
    exit;
}

function ssr_not_found(): never
{
    http_response_code(404);
    $notFound = __DIR__ . '/404.html';
    if (is_file($notFound)) {
        header('Content-Type: text/html; charset=utf-8');
        readfile($notFound);
    } else {
        header('Content-Type: text/plain; charset=utf-8');
        echo "404 Not Found\n";
    }
    exit;
}

// ── Which page? ─────────────────────────────────────────────────────────────

$page = $_GET['page'] ?? '';
$page = is_string($page) ? trim($page, '/') : '';

// Original client request (REQUEST_URI survives the internal rewrite).
$requestUri   = (string) ($_SERVER['REQUEST_URI'] ?? '/');
$requestPath  = (string) (parse_url($requestUri, PHP_URL_PATH) ?? '/');
$requestQuery = [];
parse_str((string) (parse_url($requestUri, PHP_URL_QUERY) ?? ''), $requestQuery);

// Legacy internal rewrite "index.php?lang=en" (old .htaccess) = English home.
$legacyLang = $_GET['lang'] ?? $_GET['lan'] ?? null;
if ($page === '' && $legacyLang === 'en' && !isset($requestQuery['lang']) && !isset($requestQuery['lan'])) {
    $page = 'en';
}

// Server-side directories never hold pages.
if ($page !== '' && (!preg_match('/^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/', $page)
    || preg_match('/^(?:api|cron|data|lib|_astro)(?:\/|$)/', $page))) {
    ssr_not_found();
}
if ($page === 'index') {
    ssr_redirect('/');
}
$isHome = $page === '' || $page === 'en';

// Duplicate URLs -> one canonical URL (defensive; .htaccess does the same for
// client requests). "?lang=xx" / "?lan=xx" on a home page goes to that
// language's home, on any other page the parameter is dropped.
$queryLang = $requestQuery['lang'] ?? $requestQuery['lan'] ?? null;
if ($queryLang !== null) {
    ssr_redirect($isHome ? ($queryLang === 'en' ? '/en' : '/') : '/' . $page);
}
// Trailing-slash variant ("/en/", "/forecasts/") -> no slash (trailingSlash: 'never').
if ($requestPath !== '/' && str_ends_with($requestPath, '/') && !str_contains($requestPath, '..')) {
    $clean = rtrim($requestPath, '/');
    $query = (string) (parse_url($requestUri, PHP_URL_QUERY) ?? '');
    ssr_redirect(($clean === '' ? '/' : $clean) . ($query !== '' ? '?' . $query : ''));
}

// Resolve the template strictly inside the web root.
$root = realpath(__DIR__);
$templatePath = $page === '' ? __DIR__ . '/index.html' : __DIR__ . '/' . $page . '.html';
$real = realpath($templatePath);
if ($root === false || $real === false || !is_file($real) || !str_starts_with($real, $root . DIRECTORY_SEPARATOR)) {
    if ($page === '') {
        http_response_code(503);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Site not deployed yet: index.html is missing (deploy the Astro build output alongside this file).";
        exit;
    }
    ssr_not_found();
}
if ($page === '404') {
    ssr_not_found();
}

if (is_file(__DIR__ . '/lib/CrawlerLog.php')) {
    require_once __DIR__ . '/lib/CrawlerLog.php';
    if (class_exists('CrawlerLog')) {
        try {
            CrawlerLog::record((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), '/' . $page);
        } catch (Throwable) {
            // Logging must never break the page.
        }
    }
}

$template = (string) file_get_contents($real);

// Language from the template itself (<html lang="xx">). Format/I18n strings
// exist for de and en; other languages get the English wording.
$lang = preg_match('/<html\b[^>]*\slang="([a-zA-Z]{2})/', $template, $m) ? strtolower($m[1]) : 'de';
$ssrLang = I18n::isSupported($lang) ? $lang : 'en';

// ── Data (DB only when the page shows live values) ──────────────────────────

$data = ssr_default_data();
$siteUrl = 'https://gotthard.jubr.app';

$configPath = __DIR__ . '/cron/config.php';
$config = null;
if (is_file($configPath)) {
    try {
        $config = require $configPath;
        $siteUrl = is_array($config) ? ($config['site_url'] ?? $siteUrl) : $siteUrl;
    } catch (Throwable) {
        $config = null;
    }
}
if (is_array($config) && Ssr::needsSnapshot($template)) {
    try {
        $store = new SnapshotStore(Db::connect($config));
        $row   = $store->latest();
        if ($row !== null) {
            $data = SnapshotMapper::fromRow($row);
        }
    } catch (Throwable) {
        // Fall through to default data — DB unavailable or not yet configured.
    }
}

$forecast = Ssr::needsForecast($template) ? ForecastTable::load(__DIR__ . '/forecast-days.json') : null;

// Home pages: canonical from a fixed base (never HTTP_HOST / REQUEST_URI),
// "<base>/" for de, "<base>/en" for en. Other pages keep Astro's own head.
$siteUrl      = rtrim((string) $siteUrl, '/');
$canonicalUrl = $page === 'en' ? $siteUrl . '/en' : $siteUrl . '/';

$html = Ssr::render($template, $data, $ssrLang, $canonicalUrl, [
    'head'     => $isHome,
    'forecast' => $forecast,
]);

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=60');
if (!empty($data['updated'])) {
    $lastModified = strtotime((string) $data['updated']);
    if ($lastModified !== false) {
        header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $lastModified) . ' GMT');
    }
}
echo $html;
