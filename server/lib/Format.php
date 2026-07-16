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

    /** "HH:MM" (Swiss local) for a closure's reopening time, or null if unknown/invalid. */
    public static function reopeningTime(?string $iso): ?string
    {
        if ($iso === null || trim($iso) === '') {
            return null;
        }
        try {
            $date = new DateTimeImmutable($iso);
        } catch (Exception) {
            return null;
        }
        return $date->setTimezone(new DateTimeZone('Europe/Zurich'))->format('H:i');
    }

    public static function km(?float $km, string $lang): string
    {
        if ($km === null) {
            return '–';
        }
        if ($km <= 0) {
            return I18n::t($lang, 'portal.noQueue');
        }
        $formatted = rtrim(rtrim(number_format($km, 1, '.', "'"), '0'), '.');
        return "{$formatted} km";
    }

    public static function minutes(?int $min, string $lang): string
    {
        if ($min === null || $min <= 0) {
            return '–';
        }
        return "{$min} " . I18n::t($lang, 'portal.minutes');
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
        return $lang === 'de' ? $date->format('d.m.Y, H:i') : $date->format('M j, Y, H:i');
    }

    public static function summary(array $data, string $lang): string
    {
        $north = $data['tunnel']['north'];
        $south = $data['tunnel']['south'];
        $noNorth = ($north['queueKm'] ?? 0) <= 0;
        $noSouth = ($south['queueKm'] ?? 0) <= 0;
        $passLabel = mb_strtolower(self::passStatusLabel($data['pass']['status'], $lang));

        if (($data['tunnel']['status'] ?? '') === 'closed') {
            $reason = self::closureCauseLabel($data['tunnel']['closureReason'] ?? null, $lang);
            $reopen = self::reopeningTime($data['tunnel']['closureUntil'] ?? null);
            if ($lang === 'de') {
                $lead = 'Gotthard-Strassentunnel gesperrt' . ($reason ? " ({$reason})" : '');
                $when = $reopen ? " – voraussichtliche Öffnung um {$reopen} Uhr" : ' – Wiedereröffnungszeit noch nicht bekannt';
                return "{$lead}{$when}. Gotthardpass: {$passLabel}.";
            }
            $lead = 'Gotthard road tunnel closed' . ($reason ? " ({$reason})" : '');
            $when = $reopen ? " – expected to reopen around {$reopen}" : ' – reopening time not yet known';
            return "{$lead}{$when}. Gotthard Pass: {$passLabel}.";
        }

        if ($lang === 'de') {
            if ($noNorth && $noSouth) {
                return "Aktuell freie Fahrt am Gotthard-Strassentunnel in beide Richtungen. Gotthardpass: {$passLabel}.";
            }
            $parts = [];
            if (!$noNorth) {
                $parts[] = self::km($north['queueKm'], $lang) . ' Rückstau am Nordportal (Göschenen), ca. ' . self::minutes($north['waitMinutes'], $lang) . ' Wartezeit';
            }
            if (!$noSouth) {
                $parts[] = self::km($south['queueKm'], $lang) . ' Rückstau am Südportal (Airolo), ca. ' . self::minutes($south['waitMinutes'], $lang) . ' Wartezeit';
            }
            return 'Aktuell: ' . implode('; ', $parts) . ". Gotthardpass: {$passLabel}.";
        }

        if ($noNorth && $noSouth) {
            return "Currently clear at the Gotthard road tunnel in both directions. Gotthard Pass: {$passLabel}.";
        }
        $parts = [];
        if (!$noNorth) {
            $parts[] = self::km($north['queueKm'], $lang) . ' queue at the north portal (Göschenen), about ' . self::minutes($north['waitMinutes'], $lang) . ' wait';
        }
        if (!$noSouth) {
            $parts[] = self::km($south['queueKm'], $lang) . ' queue at the south portal (Airolo), about ' . self::minutes($south['waitMinutes'], $lang) . ' wait';
        }
        return 'Right now: ' . implode('; ', $parts) . ". Gotthard Pass: {$passLabel}.";
    }
}
