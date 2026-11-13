<?php

declare(strict_types=1);

require_once __DIR__ . '/I18n.php';
require_once __DIR__ . '/Format.php';

/**
 * Embeddable shields-style status badge for api/badge.php, e.g.
 * "Gotthard | Nord 3.2 km · 25 Min", "Gotthard | freie Fahrt", "Gotthard | gesperrt".
 */
final class Badge
{
    public const DIRS = ['both', 'north', 'south'];

    private const GREEN = '#2e7d32';
    private const ORANGE = '#b45309';
    private const RED = '#c62828';
    private const GREY = '#6b7280';
    private const LABEL_BG = '#555';

    /**
     * Label, value and colour for the current data.
     *
     * @return array{label: string, value: string, color: string}
     */
    public static function model(array $data, string $lang, string $dir = 'both', ?DateTimeImmutable $now = null): array
    {
        $de = $lang === 'de';
        $dir = in_array($dir, self::DIRS, true) ? $dir : 'both';
        $label = match ($dir) {
            'north' => $de ? 'Gotthard Nord' : 'Gotthard north',
            'south' => $de ? 'Gotthard Süd' : 'Gotthard south',
            default => 'Gotthard',
        };
        $out = static fn (string $value, string $color): array => ['label' => $label, 'value' => $value, 'color' => $color];

        $fresh = Format::freshness($data['updated'] ?? null, $now);
        if ($fresh['ageMin'] === null) {
            return $out($de ? 'keine Daten' : 'no data', self::GREY);
        }
        if ($fresh['level'] !== 'fresh') {
            return $out($de ? 'Daten veraltet' : 'data stale', self::GREY);
        }

        $tunnel = is_array($data['tunnel'] ?? null) ? $data['tunnel'] : [];
        $status = (string) ($tunnel['status'] ?? 'unknown');
        if ($status === 'closed') {
            return $out($de ? 'gesperrt' : 'closed', self::RED);
        }

        $sides = $dir === 'both' ? ['north', 'south'] : [$dir];
        $queued = [];
        $allUnknown = true;
        foreach ($sides as $side) {
            $portal = is_array($tunnel[$side] ?? null) ? $tunnel[$side] : [];
            $km = isset($portal['queueKm']) ? (float) $portal['queueKm'] : null;
            if ($km !== null) {
                $allUnknown = false;
            }
            if ($km !== null && $km > 0) {
                $wait = isset($portal['waitMinutes']) ? (int) $portal['waitMinutes'] : null;
                $queued[$side] = ['km' => $km, 'wait' => $wait];
            }
        }

        if ($queued === []) {
            if ($status === 'unknown' && $allUnknown) {
                return $out($de ? 'unbekannt' : 'unknown', self::GREY);
            }
            return $out($de ? 'freie Fahrt' : 'no queue', self::GREEN);
        }

        $name = static fn (string $side): string => $side === 'north' ? ($de ? 'Nord' : 'north') : ($de ? 'Süd' : 'south');
        $withWait = static function (array $q) use ($lang): string {
            $text = Format::km($q['km'], $lang);
            return $q['wait'] !== null && $q['wait'] > 0 ? $text . ' · ' . Format::minutes($q['wait'], $lang) : $text;
        };

        if ($dir !== 'both') {
            $value = $withWait($queued[$dir]);
        } elseif (count($queued) === 1) {
            $side = array_key_first($queued);
            $value = $name($side) . ' ' . $withWait($queued[$side]);
        } else {
            $value = $name('north') . ' ' . Format::km($queued['north']['km'], $lang)
                . ' · ' . $name('south') . ' ' . Format::km($queued['south']['km'], $lang);
        }
        return $out($value, self::ORANGE);
    }

    /** Approximate Verdana 11px advance width; textLength pins the exact width. */
    private static function textWidth(string $text): float
    {
        $w = 0.0;
        foreach (mb_str_split($text) as $ch) {
            $w += match (true) {
                str_contains("ijl.,:;!|'·", $ch) => 3.6,
                str_contains('ftrI ()', $ch) => 4.8,
                str_contains('mwMW', $ch) => 10.0,
                ctype_upper($ch) => 7.6,
                ctype_digit($ch) => 7.0,
                default => 6.6,
            };
        }
        return round($w, 1);
    }

    private static function esc(string $s): string
    {
        return htmlspecialchars($s, ENT_QUOTES | ENT_XML1 | ENT_SUBSTITUTE, 'UTF-8');
    }

    public static function svg(string $label, string $value, string $color): string
    {
        $color = preg_match('/^#[0-9a-fA-F]{3,6}$/', $color) ? $color : self::GREY;
        $lt = self::textWidth($label);
        $vt = self::textWidth($value);
        $lw = (int) ceil($lt + 12);
        $vw = (int) ceil($vt + 12);
        $w = $lw + $vw;
        $lx = $lw / 2;
        $vx = $lw + $vw / 2;
        $title = self::esc("{$label}: {$value}");
        $l = self::esc($label);
        $v = self::esc($value);
        $bg = self::LABEL_BG;

        return <<<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="{$w}" height="20" role="img" aria-label="{$title}"><title>{$title}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="{$w}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="{$lw}" height="20" fill="{$bg}"/><rect x="{$lw}" width="{$vw}" height="20" fill="{$color}"/><rect width="{$w}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="{$lx}" y="15" fill="#010101" fill-opacity=".3" textLength="{$lt}">{$l}</text><text x="{$lx}" y="14" textLength="{$lt}">{$l}</text><text x="{$vx}" y="15" fill="#010101" fill-opacity=".3" textLength="{$vt}">{$v}</text><text x="{$vx}" y="14" textLength="{$vt}">{$v}</text></g></svg>
SVG;
    }
}
