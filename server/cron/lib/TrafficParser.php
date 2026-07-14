<?php

declare(strict_types=1);

final class TrafficParseException extends RuntimeException
{
}

/**
 * Defensive DATEX II parser for the Gotthard ROAD TUNNEL (A2, Göschenen ↔ Airolo).
 *
 * The opentransportdata.swiss / FEDRO feed labels the *entire* A2 axis
 * "Gotthard" (Basel ↔ Chiasso), so a bare "gotthard" keyword matches ~70+
 * unrelated records (lane closures near Lugano, the Göschenenalp winter road,
 * etc.). We therefore identify the tunnel by its proper name / portal names and
 * explicitly exclude side roads, read closures from the *structured*
 * RoadOrCarriagewayOrLaneManagementType field (not free text), and ignore
 * records that are not currently valid or have been rescinded.
 *
 * Run `php fetch-traffic.php --debug` against the real feed and adjust the
 * token lists below if a value comes back wrong.
 */
final class TrafficParser
{
    // Proper-name / portal tokens that positively identify the road tunnel.
    // (The A2 *axis* name "Gotthard"/"S. Gottardo"/"St-Gothard" is deliberately
    // NOT here — it appears on every A2 record along the whole motorway.)
    private const TUNNEL_TOKENS = [
        'gotthard-strassentunnel', 'gotthard strassentunnel', 'gotthardtunnel', 'gotthard-tunnel',
        'galleria del san gottardo', 'galleria autostradale del san gottardo', 'san gottardo',
        'tunnel du gothard', 'tunnel routier du gothard',
        'nordportal', 'südportal', 'suedportal', 'portale nord', 'portale sud',
    ];

    // If any of these appear the record is a *different* road/tunnel/pass, never
    // the Gotthard road tunnel — exclude even if a tunnel token also matched.
    private const EXCLUDE_TOKENS = [
        'göschenenalp', 'goeschenenalp', 'abfrutt',
        'gotthardpass', 'passstrasse', 'passo del gottardo', 'col du gothard',
        's. nicolao', 'san nicolao', 'nicolao',
    ];

    // Status-prefix words the feed uses when a message is being withdrawn.
    private const RESCINDED_TOKENS = [
        'aufgehoben', 'aufhebung', 'révoqué', 'revoqué', 'revocato', 'annullato',
    ];

    // Structured closure types that mean the whole carriageway/road is shut
    // (a *lane* closure — "laneClosures" / "rechter Fahrstreifen gesperrt" — is NOT one).
    private const FULL_CLOSURE_TYPES = ['roadclosed', 'carriagewayclosed'];

    public function __construct(private readonly array $config)
    {
    }

    /**
     * @return array{tunnel: array, pass: array, debug: array}
     */
    public function parse(string $xml): array
    {
        libxml_use_internal_errors(true);
        $doc = new DOMDocument();
        $loaded = $doc->loadXML($xml, LIBXML_NOCDATA | LIBXML_NONET);
        if (!$loaded) {
            $errors = array_map(static fn ($e) => trim($e->message), libxml_get_errors());
            libxml_clear_errors();
            throw new TrafficParseException('Failed to parse XML: ' . implode('; ', $errors));
        }

        $xpath = new DOMXPath($doc);
        $records = $xpath->query("//*[local-name()='situationRecord']");
        if ($records === false || $records->length === 0) {
            // Some feeds nest records one level up under "situation".
            $records = $xpath->query("//*[local-name()='situation']");
        }

        $passKeywords = array_map('mb_strtolower', $this->config['pass_keywords'] ?? []);
        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));

        $north = ['queueKm' => null, 'waitMinutes' => null, 'cause' => null];
        $south = ['queueKm' => null, 'waitMinutes' => null, 'cause' => null];
        $pass = ['status' => 'unknown', 'note' => null];
        $tunnelClosed = false;
        $debugMatches = [];

        if ($records !== false) {
            foreach ($records as $record) {
                /** @var DOMElement $record */
                $text = mb_strtolower($record->textContent);

                $isPass = self::containsAny($text, $passKeywords);
                $isTunnel = self::isTunnelRecord($text);
                if (!$isPass && !$isTunnel) {
                    continue;
                }

                // Ignore records that aren't in effect right now, or that the
                // feed is withdrawing (e.g. "Aufgehoben: …").
                $validityStatus = mb_strtolower(self::firstValue($xpath, $record, 'validityStatus'));
                if (self::containsAny($text, self::RESCINDED_TOKENS)) {
                    continue;
                }
                if (!self::isActiveNow($xpath, $record, $validityStatus, $now)) {
                    continue;
                }

                $debugMatches[] = $doc->saveXML($record);

                if ($isPass) {
                    if (self::isFullClosure($xpath, $record) || self::containsAny($text, ['wintersperre', 'wintersperrung'])) {
                        $pass['status'] = 'closed';
                    } elseif (self::containsAny($text, ['eingeschränkt', 'restricted', 'einspurig', 'nur mit'])) {
                        $pass['status'] = 'restricted';
                    } elseif ($pass['status'] === 'unknown') {
                        $pass['status'] = 'open';
                    }
                    $pass['note'] = self::extractComment($xpath, $record) ?? $pass['note'];
                    continue;
                }

                // Tunnel record. Full closure only from the structured type and
                // only when the operator flags it currently active.
                if ($validityStatus === 'active' && self::isFullClosure($xpath, $record)) {
                    $tunnelClosed = true;
                }

                $side = self::detectSide($text);
                $queueKm = self::extractQueueKm($xpath, $record, $text);
                $waitMinutes = self::extractWaitMinutes($xpath, $record, $text);
                $cause = self::extractComment($xpath, $record);

                if ($side === 'south') {
                    $south = self::keepWorst($south, $queueKm, $waitMinutes, $cause);
                } else {
                    $north = self::keepWorst($north, $queueKm, $waitMinutes, $cause);
                }
            }
        }

        $status = 'open';
        if ($tunnelClosed) {
            $status = 'closed';
        } elseif (($north['queueKm'] ?? 0) > 0 || ($south['queueKm'] ?? 0) > 0) {
            $status = 'congested';
        }

        return [
            'tunnel' => ['status' => $status, 'north' => $north, 'south' => $south],
            'pass' => $pass,
            'debug' => $debugMatches,
        ];
    }

    private static function isTunnelRecord(string $text): bool
    {
        if (self::containsAny($text, self::EXCLUDE_TOKENS)) {
            return false;
        }
        return self::containsAny($text, self::TUNNEL_TOKENS);
    }

    /** Is the record currently in effect? Skips suspended, future and expired ones. */
    private static function isActiveNow(DOMXPath $xpath, DOMElement $record, string $validityStatus, DateTimeImmutable $now): bool
    {
        if ($validityStatus === 'suspended') {
            return false;
        }
        $start = self::parseDate(self::firstValue($xpath, $record, 'overallStartTime'));
        if ($start !== null && $start > $now) {
            return false; // planned / not started yet
        }
        $end = self::parseDate(self::firstValue($xpath, $record, 'overallEndTime'));
        if ($end !== null && $end < $now) {
            return false; // already over
        }
        return true;
    }

    private static function isFullClosure(DOMXPath $xpath, DOMElement $record): bool
    {
        $type = mb_strtolower(self::firstValue($xpath, $record, 'roadOrCarriagewayOrLaneManagementType'));
        return $type !== '' && in_array($type, self::FULL_CLOSURE_TYPES, true);
    }

    private static function parseDate(string $value): ?DateTimeImmutable
    {
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        try {
            return new DateTimeImmutable($value);
        } catch (Throwable) {
            return null;
        }
    }

    /** First descendant text by local-name(), or '' if none. */
    private static function firstValue(DOMXPath $xpath, DOMElement $record, string $localName): string
    {
        $nodes = $xpath->query(".//*[local-name()='{$localName}']", $record);
        if ($nodes !== false && $nodes->length > 0) {
            return trim($nodes->item(0)->textContent);
        }
        return '';
    }

    private static function containsAny(string $haystack, array $needles): bool
    {
        foreach ($needles as $needle) {
            if ($needle !== '' && str_contains($haystack, $needle)) {
                return true;
            }
        }
        return false;
    }

    private static function detectSide(string $text): string
    {
        // The queue forms at the *origin* portal. "Airolo -> …" = northbound,
        // queue at the south portal (Airolo); "Göschenen -> …" = southbound,
        // queue at the north portal (Göschenen).
        if (preg_match('/airolo\s*-?\s*>/u', $text) === 1) {
            return 'south';
        }
        if (preg_match('/göschenen\s*-?\s*>/u', $text) === 1) {
            return 'north';
        }
        if (str_contains($text, 'südportal') || str_contains($text, 'suedportal') || str_contains($text, 'portale sud')) {
            return 'south';
        }
        if (str_contains($text, 'nordportal') || str_contains($text, 'portale nord')) {
            return 'north';
        }
        // Default to north (Göschenen-side southbound congestion is the common case).
        return 'north';
    }

    private static function extractQueueKm(DOMXPath $xpath, DOMElement $record, string $text): ?float
    {
        foreach (['queueLength', 'length'] as $name) {
            $value = self::firstValue($xpath, $record, $name);
            if ($value !== '') {
                $meters = (float) $value;
                if ($meters > 0) {
                    return round($meters / 1000, 1);
                }
            }
        }
        if (preg_match('/(\d+(?:[.,]\d+)?)\s?km/u', $text, $m) === 1) {
            return round((float) str_replace(',', '.', $m[1]), 1);
        }
        return null;
    }

    private static function extractWaitMinutes(DOMXPath $xpath, DOMElement $record, string $text): ?int
    {
        foreach (['delayTimeValue', 'delay', 'estimatedDurationOfDelay'] as $name) {
            $value = self::firstValue($xpath, $record, $name);
            if ($value !== '') {
                $seconds = (float) $value;
                if ($seconds > 0) {
                    return (int) round($seconds / 60);
                }
            }
        }
        if (preg_match('/(\d+)\s?(?:minuten|minutes|min)\b/u', $text, $m) === 1) {
            return (int) $m[1];
        }
        return null;
    }

    private static function extractComment(DOMXPath $xpath, DOMElement $record): ?string
    {
        foreach (['generalPublicComment', 'nonGeneralPublicComment', 'comment'] as $name) {
            $nodes = $xpath->query(".//*[local-name()='{$name}']//*[local-name()='value']", $record);
            if ($nodes !== false && $nodes->length > 0) {
                $value = trim($nodes->item(0)->textContent);
                if ($value !== '') {
                    return mb_substr($value, 0, 200);
                }
            }
        }
        return null;
    }

    /** @param array{queueKm: ?float, waitMinutes: ?int, cause: ?string} $current */
    private static function keepWorst(array $current, ?float $queueKm, ?int $waitMinutes, ?string $cause): array
    {
        if ($queueKm === null || ($current['queueKm'] !== null && $current['queueKm'] >= $queueKm)) {
            return $current;
        }
        return ['queueKm' => $queueKm, 'waitMinutes' => $waitMinutes, 'cause' => $cause];
    }
}
