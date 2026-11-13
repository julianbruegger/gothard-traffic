<?php

declare(strict_types=1);

/**
 * Aggregate search / AI crawler hits counted by CrawlerLog (last 30 days, per
 * UTC day and bot, with the paths they requested). Counts only: no IPs, no
 * user agents.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=300');
header('Access-Control-Allow-Origin: *');
header('X-Robots-Tag: noindex');

require_once __DIR__ . '/../lib/CrawlerLog.php';

echo json_encode(CrawlerLog::summary(30), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
