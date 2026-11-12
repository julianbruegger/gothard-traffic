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

    public static function summary(array $data, string $lang): string
    {
        $north = $data['tunnel']['north'];
        $south = $data['tunnel']['south'];
        $noNorth = empty($north['queueKm']) || $north['queueKm'] <= 0;
        $noSouth = empty($south['queueKm']) || $south['queueKm'] <= 0;
        $passLabel = mb_strtolower(self::passStatusLabel($data['pass']['status'] ?? 'unknown', $lang));

        if (($data['tunnel']['status'] ?? '') === 'closed') {
            $reason = self::closureCauseLabel($data['tunnel']['closureReason'] ?? null, $lang);
            if ($lang === 'de') {
                $lead = 'Gotthard-Strassentunnel gesperrt' . ($reason ? " ({$reason})" : '') . '.';
                return "{$lead} Gotthardpass: {$passLabel}.";
            }
            $lead = 'Gotthard road tunnel closed' . ($reason ? " ({$reason})" : '') . '.';
            return "{$lead} Gotthard Pass: {$passLabel}.";
        }

        if ($lang === 'de') {
            if ($noNorth && $noSouth) {
                return "Aktuell freie Fahrt am Gotthard-Strassentunnel in beide Richtungen. Gotthardpass: {$passLabel}.";
            }
            $parts = [];
            if (!$noNorth) {
                $parts[] = self::km($north['queueKm'], $lang) . ' Rückstau am Nordportal (Göschenen)' . self::waitClause($north['waitMinutes'] ?? null, $lang);
            }
            if (!$noSouth) {
                $parts[] = self::km($south['queueKm'], $lang) . ' Rückstau am Südportal (Airolo)' . self::waitClause($south['waitMinutes'] ?? null, $lang);
            }
            return 'Aktuell: ' . implode('; ', $parts) . ". Gotthardpass: {$passLabel}.";
        }

        if ($noNorth && $noSouth) {
            return "Currently clear at the Gotthard road tunnel in both directions. Gotthard Pass: {$passLabel}.";
        }
        $parts = [];
        if (!$noNorth) {
            $parts[] = self::km($north['queueKm'], $lang) . ' queue at the north portal (Göschenen)' . self::waitClause($north['waitMinutes'] ?? null, $lang);
        }
        if (!$noSouth) {
            $parts[] = self::km($south['queueKm'], $lang) . ' queue at the south portal (Airolo)' . self::waitClause($south['waitMinutes'] ?? null, $lang);
        }
        return 'Right now: ' . implode('; ', $parts) . ". Gotthard Pass: {$passLabel}.";
    }
}
