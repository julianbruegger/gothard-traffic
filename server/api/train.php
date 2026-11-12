<?php

declare(strict_types=1);

// Cached proxy for the next Göschenen -> Airolo train (transport.opendata.ch, 2 min).

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: public, max-age=60');

require_once __DIR__ . '/../lib/CachedProxy.php';

$body = CachedProxy::fetch(
    'https://transport.opendata.ch/v1/connections?from=G%C3%B6schenen&to=Airolo&limit=1',
    'train-goeschenen-airolo',
    120
);
$c = $body !== null ? (json_decode($body, true)['connections'][0] ?? null) : null;
if (!is_array($c) || empty($c['from']['departure'])) {
    http_response_code(502);
    echo json_encode(['error' => 'Upstream unavailable.']);
    exit;
}
echo json_encode(['departure' => $c['from']['departure'], 'duration' => (string) ($c['duration'] ?? '')], JSON_UNESCAPED_SLASHES);
