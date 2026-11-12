<?php

declare(strict_types=1);

/**
 * Plain-text answer for AI assistants and scripts: "Is there a queue at the
 * Gotthard right now?" One paragraph with the same answer-first sentence as the
 * live page (Format::summary), source and link. When the latest reading is
 * older than Format::STALE_AFTER_MIN it says so instead of claiming a current
 * state.
 *
 *   /api/summary.php            German (default)
 *   /api/summary.php?lang=en    English
 */

require_once __DIR__ . '/../lib/CrawlerLog.php';
CrawlerLog::record((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), (string) ($_SERVER['REQUEST_URI'] ?? '/api/summary.php'));

require_once __DIR__ . '/../lib/I18n.php';
require_once __DIR__ . '/../lib/Format.php';
require_once __DIR__ . '/../lib/Db.php';
require_once __DIR__ . '/../lib/SnapshotStore.php';
require_once __DIR__ . '/../lib/SnapshotMapper.php';

$lang = $_GET['lang'] ?? 'de';
if (!is_string($lang) || !I18n::isSupported($lang)) {
    $lang = 'de';
}

header('Content-Type: text/plain; charset=utf-8');
header('Content-Language: ' . $lang);
header('Access-Control-Allow-Origin: *');

$siteUrl = 'https://gotthard.jubr.app';
$row = null;
$configPath = __DIR__ . '/../cron/config.php';
if (is_file($configPath)) {
    try {
        $config = require $configPath;
        if (is_array($config)) {
            $siteUrl = (string) ($config['site_url'] ?? $siteUrl);
            $row = (new SnapshotStore(Db::connect($config)))->latest();
        }
    } catch (Throwable) {
        $row = null;
    }
}

if ($row === null) {
    // No reading at all: the stale guard reports "not available".
    http_response_code(503);
    header('Cache-Control: no-store');
    header('Retry-After: 180');
    echo Format::plainAnswer(['updated' => null, 'source' => ''], $lang, $siteUrl), "\n";
    exit;
}

$data = SnapshotMapper::fromRow($row);

header('Cache-Control: public, max-age=60');
$lastModified = strtotime((string) $data['updated']);
if ($lastModified !== false) {
    header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $lastModified) . ' GMT');
}

echo Format::plainAnswer($data, $lang, $siteUrl), "\n";
