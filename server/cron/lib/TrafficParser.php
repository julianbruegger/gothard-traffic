<?php

declare(strict_types=1);

final class TrafficParseException extends RuntimeException
{
}

/**
 * Defensive parser for the FEDRO/ASTRA DATEX II feed, tuned to the *actual*
 * shape of the opentransportdata.swiss "TrafficSituations" data (see a live dump
 * with `php diagnose.php`).
 *
 * Key facts learned from the real feed that drive the design:
 *
 *  1. The Gotthard ROAD-TUNNEL queues are NOT labelled with portal/tunnel names.
 *     They are ordinary A2 congestion records identified by direction + junction:
 *         "A2 Luzern -> Gotthard zwischen Anschluss Wassen und Anschluss Göschenen
 *          Sachlage: Stau Länge [km] 2.0 … Zeitverlust Anz. [min] 20"   (north portal)
 *         "A2 Chiasso -> Gotthard zwischen … und Dosierstelle Airolo
 *          Sachlage: Stau Länge [km] 1.0 … Zeitverlust Anz. [min] 10"   (south portal)
 *     The queue forms on the approach *toward* the tunnel ("-> Gotthard") and is
 *     located at the portal town (Göschenen = north, Airolo = south).
 *
 *  2. Matching on the record's whole textContent is unsafe: DATEX records embed
 *     large location dictionaries, so tokens like "Nordportal"/"Südportal"/"San
 *     Gottardo" leak in from unrelated roads (La Chaux-de-Fonds street works,
 *     Lugano). We therefore classify on the human-readable COMMENT text only.
 *
 *  3. All figures live in the free text as "Länge [km] X" and "[min] Y" (unit
 *     BEFORE the number) — the structured queueLength/delayTimeValue elements are
 *     empty in this feed.
 */
final class TrafficParser
{
    // Tokens that positively identify the Gotthard PASS road (H2 / Tremola).
    private const PASS_TOKENS = [
        'gotthardpass', 'gotthard-pass', 'gotthard pass',
        'passo del gottardo', 'passo del san gottardo',
        'col du gothard', 'col du saint-gothard', 'tremola',
    ];

    // …but never the San Bernardino / A13 pass road.
    private const PASS_EXCLUDE = [
        'san bernardino', 's. bernardino', 'a13', 'pian san giacomo',
    ];

    // Status-prefix words the feed uses when a message is being withdrawn.
    private const RESCINDED_TOKENS = [
        'aufgehoben', 'aufhebung', 'révoqué', 'revoqué', 'revocato', 'annullato',
    ];

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
            $records = $xpath->query("//*[local-name()='situation']");
        }

        $now = new DateTimeImmutable('now', new DateTimeZone('UTC'));

        $north = ['queueKm' => null, 'waitMinutes' => null, 'cause' => null];
        $south = ['queueKm' => null, 'waitMinutes' => null, 'cause' => null];
        $pass = ['status' => 'unknown', 'note' => null];
        $tunnelClosed = false;
        $closureReason = null;
        $plannedClosures = [];
        $debugMatches = [];

        if ($records !== false) {
            foreach ($records as $record) {
                /** @var DOMElement $record */

                // Classify on the human-readable comment only — the whole
                // textContent leaks unrelated location names (see class docblock).
                $comment = self::commentText($xpath, $record);
                if ($comment === '') {
                    continue;
                }
                $c = mb_strtolower($comment);

                // Skip withdrawn messages, and anything not in effect right now.
                if (self::containsAny($c, self::RESCINDED_TOKENS)) {
                    continue;
                }

                // ── Whole Gotthard tunnel bore closed / planned closure ──────
                // Handled BEFORE the "active now" gate so an upcoming closure
                // (e.g. a special transport 23:00–01:00 tonight) is still
                // surfaced as a planned event rather than silently dropped.
                if (self::isGotthardTunnelClosure($c)) {
                    // A suspended record is not in effect, neither now nor later.
                    if (mb_strtolower(self::firstValue($xpath, $record, 'validityStatus')) === 'suspended') {
                        continue;
                    }
                    $german = self::germanPart($comment);
                    [$from, $to] = self::extractWindow($xpath, $record, $comment);
                    $windows = [];
                    $activeNow = self::isClosureActiveNow($xpath, $record, $from, $to, $now);
                    if ($activeNow) {
                        $tunnelClosed = true;
                        if ($closureReason === null) {
                            $reason = self::cleanClosureCause(self::extractCause($german));
                            // Drop the bare "Tunnel gesperrt" (that's the status,
                            // not a cause) — keep only a real Ursache.
                            if ($reason !== null) {
                                $closureReason = $reason;
                            }
                        }
                        $debugMatches[] = $doc->saveXML($record);
                    } else {
                        // Upcoming one-off window, or — for a recurring nightly
                        // campaign currently outside its window — tonight's window.
                        if ($from !== null && $from > $now) {
                            $windows = [[$from, $to]];
                        } else {
                            $next = self::nextDailyWindow($xpath, $record, $now);
                            $windows = $next !== null ? [$next] : [];
                        }
                    }
                    // Every explicit one-off period that still lies ahead (a
                    // record may list several, with the first already past).
                    foreach (self::futureOneOffPeriods($xpath, $record, $now) as $w) {
                        $windows[] = $w;
                    }
                    $added = false;
                    foreach ($windows as [$pFrom, $pTo]) {
                        $key = $pFrom->format(DateTimeInterface::ATOM) . '|' . ($pTo?->format(DateTimeInterface::ATOM) ?? '');
                        $plannedClosures[$key] = [
                            'from'  => $pFrom->format(DateTimeInterface::ATOM),
                            'to'    => $pTo?->format(DateTimeInterface::ATOM),
                            'cause' => self::cleanClosureCause(self::extractCause($german)),
                        ];
                        $added = true;
                    }
                    if ($added) {
                        $debugMatches[] = $doc->saveXML($record);
                    }
                    // Expired closure (window fully in the past) → drop silently.
                    continue;
                }

                $validityStatus = mb_strtolower(self::firstValue($xpath, $record, 'validityStatus'));
                if (!self::isActiveNow($xpath, $record, $validityStatus, $now)) {
                    continue;
                }

                // ── Gotthard PASS road (H2 / Tremola) ────────────────────────
                if (self::isPass($c)) {
                    if (self::containsAny($c, ['wintersperre', 'wintersperrung', 'strecke gesperrt', 'pass gesperrt'])) {
                        $pass['status'] = 'closed';
                    } elseif ($pass['status'] !== 'closed'
                        && self::containsAny($c, ['fahrbahnverengung', 'lichtsignal', 'einspurig', 'wechselseitige', 'eingeschränkt', 'restricted', 'nur mit', 'begrenzung der breite'])
                    ) {
                        $pass['status'] = 'restricted';
                    } elseif ($pass['status'] === 'unknown') {
                        $pass['status'] = 'open';
                    }
                    $pass['note'] = self::passNote($comment);
                    $debugMatches[] = $doc->saveXML($record);
                    continue;
                }

                // ── Tunnel approach queue ────────────────────────────────────
                // Only real jams: "Sachlage: Stau" / "stockender Verkehr" or the
                // structured abnormalTrafficType. Excludes roadworks ("Baustelle,
                // Länge [km] …") which reuse the same length wording.
                $abnormal = mb_strtolower(self::firstValue($xpath, $record, 'abnormalTrafficType'));
                $isQueue = str_contains($c, 'sachlage: stau')
                    || str_contains($c, 'stockender verkehr')
                    || in_array($abnormal, ['stationarytraffic', 'queuingtraffic'], true);
                if (!$isQueue) {
                    continue;
                }

                // The queue must be on the approach *toward* the tunnel
                // ("… -> Gotthard"), not on a carriageway leaving it
                // ("Gotthard -> …" = Ticino / Uri queues far from the portal).
                if (preg_match('/(?:->|<->)\s*gotthard/u', $c) !== 1) {
                    continue;
                }

                // …and located at a portal town: Göschenen (north) / Airolo (south).
                if (str_contains($c, 'göschenen')) {
                    $side = 'north';
                } elseif (str_contains($c, 'airolo')) {
                    $side = 'south';
                } else {
                    continue; // a Stau elsewhere on the A2, not at the tunnel
                }

                $queueKm = self::extractQueueKm($xpath, $record, $c);
                $waitMin = self::extractWaitMinutes($xpath, $record, $c);
                $cause   = self::extractCause(self::germanPart($comment));

                // ASTRA often leaves a minor (<= 1 km) jam message published
                // for many hours after it cleared. Its record version time
                // stops moving, so treat such a queue as stale and ignore it.
                if ($this->isStaleMinorQueue($xpath, $record, $queueKm, $now)) {
                    continue;
                }

                $debugMatches[] = $doc->saveXML($record);
                if ($side === 'south') {
                    $south = self::keepWorst($south, $queueKm, $waitMin, $cause);
                } else {
                    $north = self::keepWorst($north, $queueKm, $waitMin, $cause);
                }
            }
        }

        // Announce only the next few windows, soonest first.
        $plannedClosures = array_values($plannedClosures);
        usort($plannedClosures, static fn (array $a, array $b): int => strcmp($a['from'], $b['from']));
        $plannedClosures = array_slice($plannedClosures, 0, self::MAX_PLANNED_CLOSURES);

        $status = 'open';
        if ($tunnelClosed) {
            $status = 'closed';
        } elseif (($north['queueKm'] ?? 0) > 0 || ($south['queueKm'] ?? 0) > 0
            || ($north['waitMinutes'] ?? 0) > 0 || ($south['waitMinutes'] ?? 0) > 0
        ) {
            $status = 'congested';
        }

        return [
            'tunnel' => [
                'status' => $status,
                'closureReason' => $tunnelClosed ? $closureReason : null,
                'north' => $north,
                'south' => $south,
                'plannedClosures' => $plannedClosures,
            ],
            'pass' => $pass,
            'debug' => $debugMatches,
        ];
    }

    /**
     * Time window [from, to] of a closure record. Prefers the structured
     * <validPeriod>/overall times, then falls back to the German free-text
     * "Dauer: … 15.07.2026 23:00 bis 16.07.2026 01:00".
     *
     * @return array{0: ?DateTimeImmutable, 1: ?DateTimeImmutable}
     */
    private static function extractWindow(DOMXPath $xpath, DOMElement $record, string $comment): array
    {
        $periods = $xpath->query(".//*[local-name()='validPeriod']", $record);
        if ($periods !== false && $periods->length > 0) {
            $period = $periods->item(0);
            $from = self::parseDate(self::nodeValue($xpath, $period, 'startOfPeriod'));
            $to   = self::parseDate(self::nodeValue($xpath, $period, 'endOfPeriod'));
            if ($from !== null || $to !== null) {
                return [$from, $to];
            }
        }

        $from = self::parseDate(self::firstValue($xpath, $record, 'overallStartTime'));
        $to   = self::parseDate(self::firstValue($xpath, $record, 'overallEndTime'));
        if ($from !== null || $to !== null) {
            return [$from, $to];
        }

        if (preg_match('/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+bis\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/u', $comment, $m) === 1) {
            $tz = new DateTimeZone('Europe/Zurich');
            return [
                self::makeDate($m[3], $m[2], $m[1], $m[4], $m[5], $tz),
                self::makeDate($m[8], $m[7], $m[6], $m[9], $m[10], $tz),
            ];
        }

        return [null, null];
    }

    /**
     * Is a closure in effect right now? Honours every <validPeriod> and its
     * recurring daily window (<recurringTimePeriodOfDay>, Swiss local time,
     * may wrap past midnight), so a nightly-only roadworks closure is not
     * reported as closed all day. Falls back to the overall [from, to] window
     * when no structured periods exist.
     */
    private static function isClosureActiveNow(DOMXPath $xpath, DOMElement $record, ?DateTimeImmutable $from, ?DateTimeImmutable $to, DateTimeImmutable $now): bool
    {
        $periods = $xpath->query(".//*[local-name()='validPeriod']", $record);
        if ($periods === false || $periods->length === 0) {
            return ($from === null || $from <= $now) && ($to === null || $to >= $now);
        }

        $local = $now->setTimezone(new DateTimeZone('Europe/Zurich'));
        $minutesNow = (int) $local->format('G') * 60 + (int) $local->format('i');

        foreach ($periods as $period) {
            $start = self::parseDate(self::nodeValue($xpath, $period, 'startOfPeriod'));
            $end   = self::parseDate(self::nodeValue($xpath, $period, 'endOfPeriod'));
            if (($start !== null && $start > $now) || ($end !== null && $end < $now)) {
                continue;
            }
            $daily = $xpath->query(".//*[local-name()='recurringTimePeriodOfDay']", $period);
            if ($daily === false || $daily->length === 0) {
                return true;
            }
            foreach ($daily as $window) {
                $a = self::parseTimeOfDay(self::nodeValue($xpath, $window, 'startTimeOfPeriod'));
                $b = self::parseTimeOfDay(self::nodeValue($xpath, $window, 'endTimeOfPeriod'));
                if ($a === null || $b === null) {
                    return true; // unreadable window: don't hide a real closure
                }
                $inside = $a <= $b
                    ? ($minutesNow >= $a && $minutesNow < $b)
                    : ($minutesNow >= $a || $minutesNow < $b);
                if ($inside) {
                    return true;
                }
            }
        }
        return false;
    }

    /**
     * Next start of a recurring daily closure window after $now (looks up to 3
     * Swiss-local days ahead), as [from, to], or null if none falls inside a
     * validPeriod.
     *
     * @return array{0: DateTimeImmutable, 1: DateTimeImmutable}|null
     */
    private static function nextDailyWindow(DOMXPath $xpath, DOMElement $record, DateTimeImmutable $now): ?array
    {
        $tz = new DateTimeZone('Europe/Zurich');
        $periods = $xpath->query(".//*[local-name()='validPeriod']", $record);
        if ($periods === false) {
            return null;
        }
        $best = null;
        foreach ($periods as $period) {
            $pStart = self::parseDate(self::nodeValue($xpath, $period, 'startOfPeriod'));
            $pEnd   = self::parseDate(self::nodeValue($xpath, $period, 'endOfPeriod'));
            $daily  = $xpath->query(".//*[local-name()='recurringTimePeriodOfDay']", $period);
            if ($daily === false) {
                continue;
            }
            foreach ($daily as $window) {
                $a = self::parseTimeOfDay(self::nodeValue($xpath, $window, 'startTimeOfPeriod'));
                $b = self::parseTimeOfDay(self::nodeValue($xpath, $window, 'endTimeOfPeriod'));
                if ($a === null || $b === null) {
                    continue;
                }
                for ($d = -1; $d <= 3; $d++) {
                    $day   = $now->setTimezone($tz)->setTime(0, 0)->modify("{$d} day");
                    $start = $day->setTime(intdiv($a, 60), $a % 60);
                    $end   = $day->setTime(intdiv($b, 60), $b % 60);
                    if ($b <= $a) {
                        $end = $end->modify('+1 day');
                    }
                    if ($start <= $now) {
                        continue;
                    }
                    if (($pStart !== null && $start < $pStart) || ($pEnd !== null && $start > $pEnd)) {
                        continue;
                    }
                    if ($best === null || $start < $best[0]) {
                        $best = [$start, $end];
                    }
                    break;
                }
            }
        }
        return $best;
    }

    /** "22:00:00" / "22:00:00+02:00" → minutes since midnight, or null. */
    private static function parseTimeOfDay(string $v): ?int
    {
        if (preg_match('/^(\d{1,2}):(\d{2})/', trim($v), $m) !== 1) {
            return null;
        }
        return (int) $m[1] * 60 + (int) $m[2];
    }

    /** Strip the bare "Tunnel gesperrt" status prefix and trailing punctuation. */
    private static function cleanClosureCause(?string $cause): ?string
    {
        if ($cause === null) {
            return null;
        }
        $cause = trim(preg_replace('/^tunnel gesperrt\s*/iu', '', $cause) ?? $cause);
        $cause = trim($cause, " 	,;:.");
        return $cause === '' ? null : $cause;
    }

    private static function makeDate(string $y, string $mo, string $d, string $h, string $i, DateTimeZone $tz): ?DateTimeImmutable
    {
        $dt = DateTimeImmutable::createFromFormat('!Y-m-d H:i', "{$y}-{$mo}-{$d} {$h}:{$i}", $tz);
        return $dt ?: null;
    }

    private static function isPass(string $c): bool
    {
        if (self::containsAny($c, self::PASS_EXCLUDE)) {
            return false;
        }
        return self::containsAny($c, self::PASS_TOKENS);
    }

    /**
     * Does this comment describe the *road tunnel bore* being fully closed?
     * Anchored on the ASTRA "Sachlage: Tunnel gesperrt" wording, then on the
     * Gotthard road-tunnel identity. Two phrasings occur in the live feed:
     *
     *   a) unplanned incident (xsi:type RoadOrCarriagewayOrLaneManagement,
     *      roadClosed): "A2 Chiasso <-> Gotthard Tunnel Gotthard-Tunnel Sachlage:
     *      Tunnel gesperrt Ursache: Pannenfahrzeug" — names the tunnel, NOT the
     *      portal towns.
     *   b) planned special transport: "… zwischen Anschluss Göschenen und
     *      Anschluss Airolo … Sachlage: Tunnel gesperrt Ursache: Ausnahmetransport"
     *      — names both portal towns, not the tunnel.
     *
     * Requiring "gotthard-tunnel" (a) or BOTH portals (b) keeps other bores
     * (Seelisberg, San Nicolao, Monte Ceneri …) and ramp closures ("Einfahrt/
     * Ausfahrt gesperrt") from matching.
     */
    private static function isGotthardTunnelClosure(string $c): bool
    {
        if (!str_contains($c, 'tunnel gesperrt')) {
            return false;
        }
        if (str_contains($c, 'gotthard-tunnel')) {
            return true;
        }
        return str_contains($c, 'göschenen') && str_contains($c, 'airolo');
    }

    /**
     * Concatenated human-readable comment(s) of a record, whitespace-collapsed.
     * Returns '' when the record carries no real message (e.g. records whose only
     * "value" text is a validity descriptor like "duringTheNight").
     */
    private static function commentText(DOMXPath $xpath, DOMElement $record): string
    {
        foreach (['generalPublicComment', 'nonGeneralPublicComment', 'comment'] as $name) {
            $nodes = $xpath->query(".//*[local-name()='{$name}']", $record);
            if ($nodes !== false && $nodes->length > 0) {
                $parts = [];
                foreach ($nodes as $node) {
                    $t = trim(preg_replace('/\s+/u', ' ', $node->textContent) ?? '');
                    if ($t !== '') {
                        $parts[] = $t;
                    }
                }
                if ($parts) {
                    return implode(' ', $parts);
                }
            }
        }
        return '';
    }

    /**
     * Is the record in effect *right now*? Skips suspended records, and planned/
     * scheduled ones: validityStatus alone only means "published"; the real timing
     * lives in <validPeriod> (nightly closures etc.), so when explicit periods
     * exist the record is active only if NOW falls inside one.
     */
    private static function isActiveNow(DOMXPath $xpath, DOMElement $record, string $validityStatus, DateTimeImmutable $now): bool
    {
        if ($validityStatus === 'suspended') {
            return false;
        }

        $periods = $xpath->query(".//*[local-name()='validPeriod']", $record);
        if ($periods !== false && $periods->length > 0) {
            foreach ($periods as $period) {
                $start = self::parseDate(self::nodeValue($xpath, $period, 'startOfPeriod'));
                $end   = self::parseDate(self::nodeValue($xpath, $period, 'endOfPeriod'));
                $afterStart = ($start === null || $start <= $now);
                $beforeEnd  = ($end === null || $end >= $now);
                if ($afterStart && $beforeEnd) {
                    return true;
                }
            }
            return false; // has explicit periods, none contain now → planned/expired
        }

        $start = self::parseDate(self::firstValue($xpath, $record, 'overallStartTime'));
        if ($start !== null && $start > $now) {
            return false;
        }
        $end = self::parseDate(self::firstValue($xpath, $record, 'overallEndTime'));
        if ($end !== null && $end < $now) {
            return false;
        }
        return true;
    }

    /**
     * A queue of <= 1 km whose situationRecordVersionTime is older than
     * `stale_queue_hours` (default 2) is a leftover message, not a live jam.
     * Records without a version time are never treated as stale.
     */
    private function isStaleMinorQueue(DOMXPath $xpath, DOMElement $record, ?float $queueKm, DateTimeImmutable $now): bool
    {
        if ($queueKm === null || $queueKm > 1.0) {
            return false;
        }
        $version = self::parseDate(self::firstValue($xpath, $record, 'situationRecordVersionTime'));
        if ($version === null) {
            return false;
        }
        $hours = (float) ($this->config['stale_queue_hours'] ?? 2);
        return ($now->getTimestamp() - $version->getTimestamp()) > $hours * 3600;
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

    /** First descendant text by local-name() within a context node, or '' if none. */
    private static function nodeValue(DOMXPath $xpath, DOMNode $context, string $localName): string
    {
        $nodes = $xpath->query(".//*[local-name()='{$localName}']", $context);
        if ($nodes !== false && $nodes->length > 0) {
            return trim($nodes->item(0)->textContent);
        }
        return '';
    }

    /** First descendant text by local-name() within a record, or '' if none. */
    private static function firstValue(DOMXPath $xpath, DOMElement $record, string $localName): string
    {
        return self::nodeValue($xpath, $record, $localName);
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

    /**
     * Queue length in km. Structured element first (empty in the live feed), then
     * the free-text "Länge [km] 2.0" form (unit BEFORE the number), then a plain
     * "2.0 km" fallback. $c is the lower-cased comment.
     */
    private static function extractQueueKm(DOMXPath $xpath, DOMElement $record, string $c): ?float
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
        if (preg_match('/l[äa]nge\s*\[km\]\s*(\d+(?:[.,]\d+)?)/u', $c, $m) === 1) {
            return round((float) str_replace(',', '.', $m[1]), 1);
        }
        if (preg_match('/(\d+(?:[.,]\d+)?)\s?km\b/u', $c, $m) === 1) {
            return round((float) str_replace(',', '.', $m[1]), 1);
        }
        return null;
    }

    /**
     * Delay in minutes. Structured element first, then "[min] 20" (unit before
     * number), then a plain "20 min" fallback. $c is the lower-cased comment.
     */
    private static function extractWaitMinutes(DOMXPath $xpath, DOMElement $record, string $c): ?int
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
        if (preg_match('/\[min\]\s*(\d+)/u', $c, $m) === 1) {
            return (int) $m[1];
        }
        if (preg_match('/(\d+)\s?(?:minuten|minutes|min)\b/u', $c, $m) === 1) {
            return (int) $m[1];
        }
        return null;
    }

    // The feed concatenates the German/French/Italian value texts with no
    // separator ("… PannenfahrzeugLibéré: …"), so a cause capture must stop at
    // these second-language markers or it swallows the whole multilingual blob.
    private const LANG_BOUNDARY = 'Libéré|Révoqué|Approvato|Revocato';

    private const MAX_PLANNED_CLOSURES = 3;
    private const PASS_NOTE_MAX = 160;

    /**
     * The German portion of a multilingual comment: everything before the first
     * second-language marker (Libéré / Révoqué / Approvato / Revocato).
     */
    public static function germanPart(string $comment): string
    {
        if (preg_match('/(?:' . self::LANG_BOUNDARY . ')/u', $comment, $m, PREG_OFFSET_CAPTURE) === 1) {
            $comment = substr($comment, 0, $m[0][1]);
        }
        return trim($comment);
    }

    /**
     * Short human pass note from the German part, e.g.
     * "Strecke gesperrt – Wintersperre". Uses Sachlage plus Ursache /
     * Verkehrsführung when present; truncated at a word boundary.
     */
    public static function passNote(string $comment): ?string
    {
        $de = self::germanPart($comment);
        $stop = '(?=\s+(?:Sachlage|Ursache|Länge|Zusatz|Dauer|Verkehrsführung)\s*\d*:|\s+(?:Länge|Zusatz|Dauer)\b|$)';
        $parts = [];
        foreach (['Sachlage', 'Ursache', 'Verkehrsführung'] as $label) {
            if (preg_match('/' . $label . ':\s*(.+?)' . $stop . '/u', $de, $m) === 1) {
                $v = trim($m[1], " \t,;:.");
                if ($v !== '') {
                    $parts[] = $v;
                }
            }
        }
        $note = $parts ? implode(' – ', $parts) : trim(preg_replace('/^Freigegeben:\s*/u', '', $de) ?? $de);
        if ($note === '') {
            return null;
        }
        if (mb_strlen($note) > self::PASS_NOTE_MAX) {
            $cut = mb_substr($note, 0, self::PASS_NOTE_MAX - 1);
            $sp = mb_strrpos($cut, ' ');
            if ($sp !== false && $sp > 40) {
                $cut = mb_substr($cut, 0, $sp);
            }
            $note = rtrim($cut, " ,;:.–-") . '…';
        }
        return $note;
    }

    /**
     * Explicit one-off <validPeriod>s (no recurring daily window) that start
     * after $now, as [from, to] pairs.
     *
     * @return list<array{0: DateTimeImmutable, 1: ?DateTimeImmutable}>
     */
    private static function futureOneOffPeriods(DOMXPath $xpath, DOMElement $record, DateTimeImmutable $now): array
    {
        $out = [];
        $periods = $xpath->query(".//*[local-name()='validPeriod']", $record);
        if ($periods === false) {
            return $out;
        }
        foreach ($periods as $period) {
            $daily = $xpath->query(".//*[local-name()='recurringTimePeriodOfDay']", $period);
            if ($daily !== false && $daily->length > 0) {
                continue;
            }
            $start = self::parseDate(self::nodeValue($xpath, $period, 'startOfPeriod'));
            if ($start === null || $start <= $now) {
                continue;
            }
            $out[] = [$start, self::parseDate(self::nodeValue($xpath, $period, 'endOfPeriod'))];
        }
        return $out;
    }

    /** Short cause phrase from the comment: prefers "Ursache: …", then "Sachlage: …". */
    private static function extractCause(string $comment): ?string
    {
        if (preg_match('/Ursache:\s*(.+?)(?:\s+(?:Zusatz|Dauer|Verkehrsführung|Sachlage)\b|\s*(?:' . self::LANG_BOUNDARY . ')|$)/u', $comment, $m) === 1) {
            $v = trim($m[1]);
            if ($v !== '') {
                return mb_substr($v, 0, 120);
            }
        }
        if (preg_match('/Sachlage:\s*(.+?)(?:\s+(?:Länge|Ursache|Zusatz|Dauer|Verkehrsführung)\b|\s*(?:' . self::LANG_BOUNDARY . ')|$)/u', $comment, $m) === 1) {
            $v = trim($m[1]);
            if ($v !== '') {
                return mb_substr($v, 0, 120);
            }
        }
        return null;
    }

    /**
     * Keep the worse of two readings for a side. "Worse" = longer queue; ties
     * broken by longer delay. A reading with neither km nor minutes never
     * displaces an existing one.
     *
     * @param array{queueKm: ?float, waitMinutes: ?int, cause: ?string} $current
     */
    private static function keepWorst(array $current, ?float $queueKm, ?int $waitMinutes, ?string $cause): array
    {
        if ($queueKm === null && $waitMinutes === null
            && ($current['queueKm'] !== null || $current['waitMinutes'] !== null)
        ) {
            return $current;
        }

        $curKm = $current['queueKm'] ?? -1.0;
        $newKm = $queueKm ?? -1.0;
        if ($newKm > $curKm) {
            return ['queueKm' => $queueKm, 'waitMinutes' => $waitMinutes, 'cause' => $cause];
        }
        if ($newKm === $curKm && ($waitMinutes ?? -1) > ($current['waitMinutes'] ?? -1)) {
            return ['queueKm' => $queueKm, 'waitMinutes' => $waitMinutes, 'cause' => $cause];
        }
        return $current;
    }
}
