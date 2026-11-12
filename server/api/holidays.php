<?php

declare(strict_types=1);

// Cached proxy for openholidaysapi.org school holidays (6 h), so the page makes no third-party requests.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=3600');

require_once __DIR__ . '/../lib/CachedProxy.php';

$from = (string) ($_GET['from'] ?? '');
$to   = (string) ($_GET['to'] ?? '');
$date = '/^\d{4}-\d{2}-\d{2}$/';
if (!preg_match($date, $from) || !preg_match($date, $to) || $from > $to) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid range.']);
    exit;
}

$out = [];
foreach (['CH', 'DE', 'NL'] as $country) {
    $body = CachedProxy::fetch(
        "https://openholidaysapi.org/SchoolHolidays?countryIsoCode={$country}&languageIsoCode=EN&validFrom={$from}&validTo={$to}",
        "holidays-{$country}-{$from}-{$to}",
        6 * 3600
    );
    $list = $body !== null ? json_decode($body, true) : null;
    if (!is_array($list)) {
        http_response_code(502);
        echo json_encode(['error' => 'Upstream unavailable.']);
        exit;
    }
    $out[$country] = array_map(
        static fn (array $h): array => ['startDate' => (string) ($h['startDate'] ?? ''), 'endDate' => (string) ($h['endDate'] ?? '')],
        array_values(array_filter($list, 'is_array'))
    );
}
echo json_encode($out, JSON_UNESCAPED_SLASHES);
