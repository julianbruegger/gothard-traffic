<?php

declare(strict_types=1);

final class TrafficParseException extends RuntimeException
{
}

/**
 * Defensive DATEX II parser. The exact element names/namespaces returned by
 * opentransportdata.swiss can vary by feed version, and this project was
 * built without a live API token to verify against - so matching is done by
 * local-name() (namespace-agnostic) plus keyword search over each record's
 * full text content, rather than a strict schema-bound XPath. Run
 * `php fetch-traffic.php --debug` against your real feed and adjust the
 * KEYWORDS lists in config.php (or the field names below) if a value comes
 * back empty.
 */
final class TrafficParser
{
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

        $tunnelKeywords = array_map('mb_strtolower', $this->config['keywords'] ?? []);
        $passKeywords = array_map('mb_strtolower', $this->config['pass_keywords'] ?? []);

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
                $isTunnelRelated = self::containsAny($text, $tunnelKeywords);
                if (!$isPass && !$isTunnelRelated) {
                    continue;
                }

                $debugMatches[] = $doc->saveXML($record);

                if ($isPass) {
                    if (self::containsAny($text, ['gesperrt', 'geschlossen', 'closed', 'wintersperre'])) {
                        $pass['status'] = 'closed';
                    } elseif (self::containsAny($text, ['eingeschränkt', 'restricted', 'einspurig'])) {
                        $pass['status'] = 'restricted';
                    } elseif ($pass['status'] === 'unknown') {
                        $pass['status'] = 'open';
                    }
                    $pass['note'] = self::extractComment($xpath, $record) ?? $pass['note'];
                    continue;
                }

                $side = self::detectSide($text);
                $queueKm = self::extractQueueKm($xpath, $record, $text);
                $waitMinutes = self::extractWaitMinutes($xpath, $record, $text);
                $cause = self::extractComment($xpath, $record);
                $closed = self::containsAny($text, ['tunnel gesperrt', 'tunnel closed', 'gesperrt', 'geschlossen', 'closed']);
                if ($closed) {
                    $tunnelClosed = true;
                }

                if ($side === 'south') {
                    $south = self::keepWorst($south, $queueKm, $waitMinutes, $cause);
                } else {
                    // Default to north when direction is ambiguous - Göschenen-side
                    // congestion (southbound traffic queuing to enter) is the far
                    // more common real-world case reported in these feeds.
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
        if (str_contains($text, 'airolo') || str_contains($text, 'südportal') || str_contains($text, 'south portal')) {
            return 'south';
        }
        return 'north';
    }

    private static function extractQueueKm(DOMXPath $xpath, DOMElement $record, string $text): ?float
    {
        foreach (['queueLength', 'length'] as $name) {
            $nodes = $xpath->query(".//*[local-name()='{$name}']", $record);
            if ($nodes !== false && $nodes->length > 0) {
                $meters = (float) trim($nodes->item(0)->textContent);
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
            $nodes = $xpath->query(".//*[local-name()='{$name}']", $record);
            if ($nodes !== false && $nodes->length > 0) {
                $seconds = (float) trim($nodes->item(0)->textContent);
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
