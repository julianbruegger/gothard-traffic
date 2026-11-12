<?php

declare(strict_types=1);

require_once __DIR__ . '/I18n.php';

/** Mirrors site/src/lib/format.ts - keep both in sync when changing wording/logic. */
final class Format
{
    /** DATEX "Ursache" values seen on Gotthard closures → friendly label. */
    private const CLOSURE_CAUSE = [
        'ausnahmetransport' => ['de' => 'Sondertransport', 'en' => 'Special transport'],
        'sondertransport'   => ['de' => 'Sondertransport', 'en' => 'Special transport'],
        'pannenfahrzeug'    => ['de' => 'Pannenfahrzeug', 'en' => 'Broken-down vehicle'],
        'unfall'            => ['de' => 'Unfall', 'en' => 'Accident'],
        'brand'             => ['de' => 'Brand', 'en' => 'Fire'],
        'wartung'           => ['de' => 'Wartungsarbeiten', 'en' => 'Maintenance'],
        'unterhalt'         => ['de' => 'Unterhaltsarbeiten', 'en' => 'Maintenance'],
        'unterhaltsarbeiten' => ['de' => 'Unterhaltsarbeiten', 'en' => 'Maintenance'],
        'bauarbeiten'       => ['de' => 'Bauarbeiten', 'en' => 'Roadworks'],
        'baustelle'         => ['de' => 'Bauarbeiten', 'en' => 'Roadworks'],
    ];

    public static function closureCauseLabel(?string $cause, string $lang): ?string
    {
        if ($cause === null || trim($cause) === '') {
            return null;
        }
        $hit = self::CLOSURE_CAUSE[mb_strtolower(trim($cause))] ?? null;
        return $hit[$lang] ?? $cause;
    }

    public static function km(?float $km, string $lang): string
    {
        if ($km === null) {
            return '–';
        }
        if ($km <= 0) {
            return I18n::t($lang, 'portal.noQueue');
        }
        // Mirrors toLocaleString with exactly 1 fraction digit (de-CH / en-CH both use ' and .).
        return number_format($km, 1, '.', "'") . ' km';
    }

    public static function minutes(?int $min, string $lang): string
    {
        if ($min === null || $min <= 0) {
            return '–';
        }
        return round($min) . ' ' . I18n::t($lang, 'portal.minutes');
    }

    /** Mirrors format.ts formatWait(): a known empty queue reads "0 Min", unknown stays a dash. */
    public static function wait(?float $queueKm, ?int $min, string $lang): string
    {
        if ($min !== null && $min > 0) {
            return self::minutes($min, $lang);
        }
        if ($queueKm !== null && $queueKm <= 0) {
            return '0 ' . I18n::t($lang, 'portal.minutes');
        }
        return '–';
    }

    public static function statusLabel(string $status, string $lang): string
    {
        return match ($status) {
            'open' => I18n::t($lang, 'status.open'),
            'congested' => I18n::t($lang, 'status.congested'),
            'restricted' => I18n::t($lang, 'status.restricted'),
            'closed' => I18n::t($lang, 'status.closed'),
            default => I18n::t($lang, 'status.unknown'),
        };
    }

    public static function passStatusLabel(string $status, string $lang): string
    {
        return match ($status) {
            'open' => I18n::t($lang, 'pass.open'),
            'closed' => I18n::t($lang, 'pass.closed'),
            'restricted' => I18n::t($lang, 'pass.restricted'),
            default => I18n::t($lang, 'pass.unknown'),
        };
    }

    public static function updated(?string $iso, string $lang): string
    {
        if (!$iso) {
            return '–';
        }
        try {
            $date = new DateTimeImmutable($iso);
        } catch (Exception) {
            return '–';
        }
        $date = $date->setTimezone(new DateTimeZone('Europe/Zurich'));
        // Same as Intl dateStyle:medium / timeStyle:short for de-CH / en-CH.
        return $lang === 'de' ? $date->format('d.m.Y, H:i') : $date->format('j M Y, H:i');
    }

    /** Headline for a planned closure (mirrors closureTitle in format.ts). */
    public static function closureTitle(array $c, string $lang): string
    {
        $tz = new DateTimeZone('Europe/Zurich');
        $startsToday = false;
        try {
            $from = (new DateTimeImmutable((string) ($c['from'] ?? '')))->setTimezone($tz);
            $now = new DateTimeImmutable('now', $tz);
            $startsToday = $from->format('Y-m-d') === $now->format('Y-m-d') && $from > $now;
        } catch (Exception) {
        }
        if ($lang === 'de') {
            return $startsToday ? 'Geplante Sperrung heute Nacht!' : 'Geplante Tunnelsperrung';
        }
        return $startsToday ? 'Planned closure tonight!' : 'Planned tunnel closure';
    }

    /** Detail line, e.g. "Sondertransport – 15.07., 23:00–01:00" (mirrors closureDetail in format.ts). */
    public static function closureDetail(array $c, string $lang): string
    {
        $tz = new DateTimeZone('Europe/Zurich');
        $parse = static function ($v) use ($tz): ?DateTimeImmutable {
            if (!is_string($v) || $v === '') {
                return null;
            }
            try {
                return (new DateTimeImmutable($v))->setTimezone($tz);
            } catch (Exception) {
                return null;
            }
        };
        $from = $parse($c['from'] ?? null);
        $to = $parse($c['to'] ?? null);

        $range = '';
        if ($from !== null) {
            $day = $lang === 'de' ? 'd.m.' : 'd.m';
            if ($to !== null) {
                $range = $from->format('Y-m-d') === $to->format('Y-m-d')
                    ? $from->format($day) . ', ' . $from->format('H:i') . '–' . $to->format('H:i')
                    : $from->format($day . ' H:i') . ' – ' . $to->format($day . ' H:i');
            } else {
                $range = $from->format($day . ' H:i');
            }
        }

        $cause = self::closureCauseLabel($c['cause'] ?? null, $lang);
        if ($cause !== null && $range !== '') {
            return "{$cause} – {$range}";
        }
        return $cause ?? $range;
    }

    /** ", ca. 20 min Wartezeit" - omitted entirely when the wait is unknown. */
    private static function waitClause(?int $min, string $lang): string
    {
        if ($min === null || $min <= 0) {
            return '';
        }
        $m = self::minutes($min, $lang);
        return $lang === 'de' ? ", ca. {$m} Wartezeit" : ", about {$m} wait";
    }

    // ─── Data freshness (mirrors dataFreshness / formatAge in format.ts) ────────

    /** Older than this, a reading is flagged as stale. */
    public const STALE_AFTER_MIN = 20;
    /** Older than this (or no timestamp at all), live data counts as unavailable. */
    public const UNAVAILABLE_AFTER_MIN = 360;

    /** @return array{level: string, ageMin: int|null} level is 'fresh', 'stale' or 'unavailable' */
    public static function freshness(?string $updated, ?DateTimeImmutable $now = null): array
    {
        $ts = self::parseSwiss($updated);
        if ($ts === null) {
            return ['level' => 'unavailable', 'ageMin' => null];
        }
        $now ??= new DateTimeImmutable('now');
        $ageMin = max(0, intdiv($now->getTimestamp() - $ts->getTimestamp(), 60));
        $level = $ageMin > self::UNAVAILABLE_AFTER_MIN ? 'unavailable' : ($ageMin > self::STALE_AFTER_MIN ? 'stale' : 'fresh');
        return ['level' => $level, 'ageMin' => $ageMin];
    }

    /** "25 Min", "2 Std 5 Min" / "25 min", "2 h 5 min". */
    public static function age(int $ageMin, string $lang): string
    {
        $min = I18n::t($lang, 'portal.minutes');
        if ($ageMin < 60) {
            return "{$ageMin} {$min}";
        }
        $h = intdiv($ageMin, 60);
        $m = $ageMin % 60;
        $hUnit = $lang === 'de' ? 'Std' : 'h';
        return $m ? "{$h} {$hUnit} {$m} {$min}" : "{$h} {$hUnit}";
    }

    // ─── Answer-first summary (mirrors buildSummary in format.ts) ─────────────

    private const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    private static function parseSwiss(mixed $iso): ?DateTimeImmutable
    {
        if (!is_string($iso) || trim($iso) === '') {
            return null;
        }
        try {
            return (new DateTimeImmutable($iso))->setTimezone(new DateTimeZone('Europe/Zurich'));
        } catch (Exception) {
            return null;
        }
    }

    /** "15.07." / "15 Jul" (Swiss calendar day). */
    private static function dayMonth(DateTimeImmutable $d, string $lang): string
    {
        return $lang === 'de' ? $d->format('d.m.') : $d->format('j') . ' ' . self::MONTHS_EN[(int) $d->format('n') - 1];
    }

    /** de: "heute", "morgen", "15.07."; en: "today", "tonight" (from 18:00), "tomorrow", "15 Jul". */
    private static function relativeDay(DateTimeImmutable $d, DateTimeImmutable $now, string $lang): string
    {
        $today = $now->format('Y-m-d');
        $tomorrow = (new DateTimeImmutable($today, new DateTimeZone('UTC')))->modify('+1 day')->format('Y-m-d');
        $day = $d->format('Y-m-d');
        if ($day === $today) {
            return $lang === 'de' ? 'heute' : ((int) $d->format('G') >= 18 ? 'tonight' : 'today');
        }
        if ($day === $tomorrow) {
            return $lang === 'de' ? 'morgen' : 'tomorrow';
        }
        return self::dayMonth($d, $lang);
    }

    /** Friendly cause label; mapped English labels are lower-cased to read inside a sentence. */
    private static function inlineCause(?string $cause, string $lang): ?string
    {
        $label = self::closureCauseLabel($cause, $lang);
        if ($label === null) {
            return null;
        }
        if ($lang === 'en' && $label !== $cause) {
            return mb_strtolower($label);
        }
        return $label;
    }

    /**
     * First planned closure that has not ended yet (the list is sorted by start).
     *
     * @return array{from: DateTimeImmutable, to: ?DateTimeImmutable, cause: ?string}|null
     */
    private static function nextClosure(array $closures, DateTimeImmutable $now): ?array
    {
        foreach ($closures as $c) {
            if (!is_array($c)) {
                continue;
            }
            $from = self::parseSwiss($c['from'] ?? null);
            if ($from === null) {
                continue;
            }
            $to = self::parseSwiss($c['to'] ?? null);
            if (($to ?? $from) > $now) {
                $cause = $c['cause'] ?? null;
                return ['from' => $from, 'to' => $to, 'cause' => is_string($cause) ? $cause : null];
            }
        }
        return null;
    }

    /** "heute 23:00–01:00 Uhr (Unterhaltsarbeiten)" / "tonight 23:00–01:00 (maintenance)". */
    private static function closurePhrase(array $c, DateTimeImmutable $now, string $lang): string
    {
        $from = $c['from'];
        $to = $c['to'];
        $de = $lang === 'de';
        $day = self::relativeDay($from, $now, $lang);
        $t1 = $from->format('H:i');
        if ($to === null) {
            $text = $de ? "{$day} ab {$t1} Uhr" : "{$day} from {$t1}";
        } elseif ($to->getTimestamp() - $from->getTimestamp() < 86400) {
            $t2 = $to->format('H:i');
            $text = $de ? "{$day} {$t1}–{$t2} Uhr" : "{$day} {$t1}–{$t2}";
        } else {
            $day2 = self::relativeDay($to, $now, $lang);
            $t2 = $to->format('H:i');
            $text = $de ? "{$day} {$t1} Uhr bis {$day2} {$t2} Uhr" : "{$day} {$t1} to {$day2} {$t2}";
        }
        $cause = self::inlineCause($c['cause'], $lang);
        return $cause !== null ? "{$text} ({$cause})" : $text;
    }

    /**
     * Answer-first summary: one to three self-contained, quotable sentences with
     * the Swiss-time timestamp, queue figures, pass status and the next planned
     * closure. Crawlers, snippets, AI assistants and api/summary.php quote it.
     * $now only decides "today/tomorrow" and which planned closures are over.
     */
    public static function summary(array $data, string $lang, ?DateTimeImmutable $now = null): string
    {
        $now = ($now ?? new DateTimeImmutable('now'))->setTimezone(new DateTimeZone('Europe/Zurich'));
        $de = $lang === 'de';
        $tunnel = is_array($data['tunnel'] ?? null) ? $data['tunnel'] : [];
        $north = is_array($tunnel['north'] ?? null) ? $tunnel['north'] : [];
        $south = is_array($tunnel['south'] ?? null) ? $tunnel['south'] : [];
        $noNorth = empty($north['queueKm']) || $north['queueKm'] <= 0;
        $noSouth = empty($south['queueKm']) || $south['queueKm'] <= 0;
        $status = (string) ($tunnel['status'] ?? 'unknown');

        $stamp = self::parseSwiss($data['updated'] ?? null) !== null ? self::updated($data['updated'], $lang) : null;
        $head = $de
            ? 'Gotthard-Strassentunnel' . ($stamp !== null ? ", {$stamp} Uhr" : '') . ': '
            : 'Gotthard road tunnel' . ($stamp !== null ? ", {$stamp}" : '') . ': ';

        if ($status === 'closed') {
            $reason = self::inlineCause($tunnel['closureReason'] ?? null, $lang);
            $body = ($de ? 'gesperrt' : 'closed') . ($reason !== null ? " ({$reason})" : '');
        } elseif ($status === 'unknown' && ($north['queueKm'] ?? null) === null && ($south['queueKm'] ?? null) === null) {
            $body = $de ? 'Verkehrslage unbekannt' : 'traffic situation unknown';
        } elseif ($noNorth && $noSouth) {
            $body = $de ? 'kein Stau in beiden Richtungen' : 'no queue in either direction';
        } else {
            $parts = [];
            if (!$noNorth) {
                $parts[] = self::km((float) $north['queueKm'], $lang)
                    . ($de ? ' Rückstau am Nordportal (Göschenen)' : ' queue at the north portal (Göschenen)')
                    . self::waitClause(isset($north['waitMinutes']) ? (int) $north['waitMinutes'] : null, $lang);
            }
            if (!$noSouth) {
                $parts[] = self::km((float) $south['queueKm'], $lang)
                    . ($de ? ' Rückstau am Südportal (Airolo)' : ' queue at the south portal (Airolo)')
                    . self::waitClause(isset($south['waitMinutes']) ? (int) $south['waitMinutes'] : null, $lang);
            }
            $body = implode('; ', $parts);
        }

        $pass = self::passStatusLabel((string) ($data['pass']['status'] ?? 'unknown'), $lang);
        $out = $head . $body . '. ' . ($de ? "Gotthardpass: {$pass}." : 'Gotthard Pass: ' . mb_strtolower($pass) . '.');

        $planned = is_array($tunnel['plannedClosures'] ?? null) ? $tunnel['plannedClosures'] : [];
        $next = self::nextClosure($planned, $now);
        if ($next !== null) {
            $out .= ($de ? ' Nächste geplante Sperrung: ' : ' Next planned closure: ') . self::closurePhrase($next, $now, $lang) . '.';
        }
        return $out;
    }

    /**
     * Replaces summary() when the reading is too old to describe current traffic
     * (freshness level not "fresh"). Never claims a current state.
     */
    public static function staleSummary(array $data, string $lang, ?DateTimeImmutable $now = null): string
    {
        $de = $lang === 'de';
        $f = self::freshness($data['updated'] ?? null, $now);
        if ($f['ageMin'] === null) {
            return $de
                ? 'Gotthard-Strassentunnel: Live-Verkehrsdaten sind derzeit nicht verfügbar, die aktuelle Verkehrslage ist unbekannt.'
                : 'Gotthard road tunnel: live traffic data is currently not available, so the current traffic situation is unknown.';
        }
        $stamp = self::updated($data['updated'], $lang);
        $age = self::age($f['ageMin'], $lang);
        return $de
            ? "Gotthard-Strassentunnel: keine aktuellen Verkehrsdaten. Die letzte Messung ist vom {$stamp} Uhr (vor {$age}), die aktuelle Verkehrslage ist daher unbekannt."
            : "Gotthard road tunnel: no current traffic data. The last reading is from {$stamp} ({$age} ago), so the current traffic situation is unknown.";
    }

    /**
     * Plain-text answer for api/summary.php: the summary (or the stale notice when
     * the reading is older than STALE_AFTER_MIN), then source and live page link.
     */
    public static function plainAnswer(array $data, string $lang, string $siteUrl, ?DateTimeImmutable $now = null): string
    {
        $fresh = self::freshness($data['updated'] ?? null, $now)['level'] === 'fresh';
        $answer = $fresh ? self::summary($data, $lang, $now) : self::staleSummary($data, $lang, $now);
        $source = trim((string) ($data['source'] ?? ''));
        $source = $source !== '' ? $source : 'opentransportdata.swiss (ASTRA Traffic Situations)';
        $page = rtrim($siteUrl, '/') . ($lang === 'de' ? '/' : '/' . $lang);
        return $lang === 'de'
            ? "{$answer} Quelle: {$source}. Live-Seite: {$page}"
            : "{$answer} Source: {$source}. Live page: {$page}";
    }
}
