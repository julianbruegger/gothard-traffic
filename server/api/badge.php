<?php

declare(strict_types=1);

/**
 * Embeddable live status badge (SVG), e.g.
 *   <a href="https://gotthard.jubr.app/"><img src="https://gotthard.jubr.app/api/badge.php?lang=de" alt="Gotthard Stau aktuell"></a>
 *
 *   lang = de (default) | en
 *   dir  = both (default) | north | south   (portal: north = Göschenen, south = Airolo)
 */

require_once __DIR__ . '/../lib/CrawlerLog.php';
CrawlerLog::record((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), (string) ($_SERVER['REQUEST_URI'] ?? '/api/badge.php'));

require_once __DIR__ . '/../lib/I18n.php';
require_once __DIR__ . '/../lib/Badge.php';
require_once __DIR__ . '/../lib/Db.php';
require_once __DIR__ . '/../lib/SnapshotStore.php';
require_once __DIR__ . '/../lib/SnapshotMapper.php';

$lang = $_GET['lang'] ?? 'de';
if (!is_string($lang) || !I18n::isSupported($lang)) {
    $lang = 'de';
}
$dir = $_GET['dir'] ?? 'both';
if (!is_string($dir) || !in_array($dir, Badge::DIRS, true)) {
    $dir = 'both';
}

$data = ['updated' => null];
$configPath = __DIR__ . '/../cron/config.php';
if (is_file($configPath)) {
    try {
        $config = require $configPath;
        $row = is_array($config) ? (new SnapshotStore(Db::connect($config)))->latest() : null;
        if ($row !== null) {
            $data = SnapshotMapper::fromRow($row);
        }
    } catch (Throwable) {
        // Fall through: the badge shows "no data".
    }
}

$m = Badge::model($data, $lang, $dir);

header('Content-Type: image/svg+xml; charset=utf-8');
header('Cache-Control: public, max-age=' . ($data['updated'] !== null ? 120 : 60));
header('Access-Control-Allow-Origin: *');
header("Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'");
echo Badge::svg($m['label'], $m['value'], $m['color']);
