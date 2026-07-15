<?php

declare(strict_types=1);

/**
 * Diagnostic: dump EVERY situationRecord whose text mentions the Gotthard axis
 * (gotthard / göschenen / airolo / nordportal / südportal / stau), together with
 * how TrafficParser would classify it — so we can see records the parser is
 * *missing* (e.g. a "Stau 1 km" queue record that lacks a tunnel token and is
 * therefore skipped, while the "hohes Verkehrsaufkommen" record matches but
 * carries no length).
 *
 * Usage (CLI only):
 *   php diagnose.php            # fetch the live feed and scan it
 *   php diagnose.php file.xml   # scan a saved XML file instead of fetching
 *
 * This script is read-only: it never touches the database.
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(403);
    exit("Forbidden: run this script via CLI, not over HTTP.\n");
}

require __DIR__ . '/lib/DatexClient.php';
require __DIR__ . '/lib/TrafficParser.php';

$configPath = __DIR__ . '/config.php';
if (!is_file($configPath)) {
    fwrite(STDERR, "Missing config.php. Copy config.example.php to config.php first.\n");
    exit(1);
}
/** @var array $config */
$config = require $configPath;

// Load XML either from a saved file (argv[1]) or the live feed.
$xmlFile = $argv[1] ?? null;
if ($xmlFile !== null) {
    if (!is_file($xmlFile)) {
        fwrite(STDERR, "File not found: {$xmlFile}\n");
        exit(1);
    }
    $xml = (string) file_get_contents($xmlFile);
    fwrite(STDOUT, "Scanning saved file: {$xmlFile}\n");
} else {
    try {
        $xml = (new DatexClient($config))->fetchRaw();
    } catch (Throwable $e) {
        fwrite(STDERR, 'Fetch failed: ' . $e->getMessage() . "\n");
        exit(1);
    }
    // Also save the raw feed so we can inspect / re-run offline.
    $dump = __DIR__ . '/../data/last-feed.xml';
    @file_put_contents($dump, $xml);
    fwrite(STDOUT, 'Fetched live feed (' . strlen($xml) . " bytes), saved raw XML to {$dump}\n");
}

// Broad net: anything on the Gotthard axis, regardless of whether the parser
// would match it. Deliberately wider than TrafficParser::TUNNEL_TOKENS.
$RELEVANT = ['gotthard', 'gottardo', 'gothard', 'göschenen', 'goeschenen', 'airolo', 'nordportal', 'südportal', 'suedportal', 'portale nord', 'portale sud'];

libxml_use_internal_errors(true);
$doc = new DOMDocument();
if (!$doc->loadXML($xml, LIBXML_NOCDATA | LIBXML_NONET)) {
    fwrite(STDERR, "Could not parse XML.\n");
    exit(1);
}
$xpath = new DOMXPath($doc);
$records = $xpath->query("//*[local-name()='situationRecord']");
if ($records === false || $records->length === 0) {
    $records = $xpath->query("//*[local-name()='situation']");
}

$parser = new TrafficParser($config);
$parsed = $parser->parse($xml);

$total = $records === false ? 0 : $records->length;
fwrite(STDOUT, "Total situationRecords in feed: {$total}\n");
fwrite(STDOUT, str_repeat('=', 72) . "\n");

$shown = 0;
if ($records !== false) {
    foreach ($records as $i => $record) {
        /** @var DOMElement $record */
        $text = mb_strtolower($record->textContent);

        $hit = false;
        foreach ($RELEVANT as $needle) {
            if (str_contains($text, $needle)) {
                $hit = true;
                break;
            }
        }
        if (!$hit) {
            continue;
        }
        $shown++;

        // Pull out the interesting structured fields by local-name.
        $field = static function (string $name) use ($xpath, $record): string {
            $nodes = $xpath->query(".//*[local-name()='{$name}']", $record);
            if ($nodes !== false && $nodes->length > 0) {
                return trim(preg_replace('/\s+/u', ' ', $nodes->item(0)->textContent) ?? '');
            }
            return '(none)';
        };

        $type = $record->getAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'type');
        if ($type === '') {
            $type = $record->getAttribute('xsi:type') ?: '(no xsi:type)';
        }

        fwrite(STDOUT, "\n#{$shown}  record " . ($i + 1) . "/{$total}\n");
        fwrite(STDOUT, "  xsi:type              : {$type}\n");
        fwrite(STDOUT, '  validityStatus        : ' . $field('validityStatus') . "\n");
        fwrite(STDOUT, '  mgmtType              : ' . $field('roadOrCarriagewayOrLaneManagementType') . "\n");
        fwrite(STDOUT, '  abnormalTrafficType   : ' . $field('abnormalTrafficType') . "\n");
        fwrite(STDOUT, '  trafficConstriction   : ' . $field('trafficConstrictionType') . "\n");
        fwrite(STDOUT, '  queueLength           : ' . $field('queueLength') . "\n");
        fwrite(STDOUT, '  length                : ' . $field('length') . "\n");
        fwrite(STDOUT, '  delayTimeValue        : ' . $field('delayTimeValue') . "\n");
        fwrite(STDOUT, '  locationDescriptor    : ' . $field('locationDescriptor') . "\n");

        // Any km / min figures anywhere in the free text.
        if (preg_match_all('/(\d+(?:[.,]\d+)?)\s?km/u', $text, $km) && $km[0]) {
            fwrite(STDOUT, '  km mentioned in text  : ' . implode(', ', $km[0]) . "\n");
        }

        // A compact excerpt of the human-readable comment.
        $comment = $field('value');
        if ($comment === '(none)') {
            $comment = $field('comment');
        }
        fwrite(STDOUT, '  comment               : ' . mb_substr($comment, 0, 240) . "\n");

        // Would TrafficParser keep this record? Re-run its public logic via reflection-free heuristics.
        fwrite(STDOUT, '  >> parser verdict     : ' . classify($text) . "\n");
    }
}

fwrite(STDOUT, "\n" . str_repeat('=', 72) . "\n");
fwrite(STDOUT, "Gotthard-area records shown: {$shown}\n");
fwrite(STDOUT, "Parser result:\n");
fwrite(STDOUT, json_encode($parsed['tunnel'], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n");
fwrite(STDOUT, 'Parser matched (kept) records: ' . count($parsed['debug']) . "\n");

/**
 * Mirror of TrafficParser's public match tokens so the diagnostic can say why a
 * record is or isn't kept, without changing the parser.
 */
function classify(string $text): string
{
    $tunnelTokens = [
        'gotthard-strassentunnel', 'gotthard strassentunnel', 'gotthardtunnel', 'gotthard-tunnel',
        'galleria del san gottardo', 'galleria autostradale del san gottardo', 'san gottardo',
        'tunnel du gothard', 'tunnel routier du gothard',
        'nordportal', 'südportal', 'suedportal', 'portale nord', 'portale sud',
    ];
    $excludeTokens = [
        'göschenenalp', 'goeschenenalp', 'abfrutt',
        'gotthardpass', 'passstrasse', 'passo del gottardo', 'col du gothard',
        's. nicolao', 'san nicolao', 'nicolao',
    ];
    $passTokens = [
        'gotthardpass', 'gotthard-pass', 'gotthard pass',
        'passo del gottardo', 'passo del san gottardo',
        'col du gothard', 'col du saint-gothard', 'tremola',
    ];

    $has = static function (array $tokens) use ($text): ?string {
        foreach ($tokens as $t) {
            if ($t !== '' && str_contains($text, $t)) {
                return $t;
            }
        }
        return null;
    };

    $ex = $has($excludeTokens);
    $tun = $has($tunnelTokens);
    $pass = $has($passTokens);

    if ($pass !== null) {
        return "PASS record (token: {$pass})";
    }
    if ($ex !== null && $tun !== null) {
        return "SKIPPED — excluded by '{$ex}' even though tunnel token '{$tun}' present";
    }
    if ($ex !== null) {
        return "SKIPPED — exclude token '{$ex}'";
    }
    if ($tun !== null) {
        return "TUNNEL record (token: {$tun})";
    }
    return 'SKIPPED — no tunnel/pass token (mentions Gotthard axis but not a portal/tunnel name)';
}
