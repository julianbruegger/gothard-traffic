<?php

declare(strict_types=1);

require_once __DIR__ . '/I18n.php';

/**
 * Renders the per-day forecast (dist/forecast-days.json, written at build time
 * by site/src/pages/forecast-days.json.ts with the same model the browser uses)
 * as crawler-readable text + table for the CURRENT Swiss day.
 *
 * The markup mirrors forecastWeekHtml()/forecastRangeHtml() in
 * site/src/lib/forecast-days.ts byte for byte (that copy is the static build
 * fallback inside the markers). Change both together.
 *
 * Direction convention: "north" = queue at the north portal Göschenen = traffic
 * heading SOUTH (i18n "dir.south"); "south" = queue at Airolo = heading NORTH.
 */
final class ForecastTable
{
    /** Peaks below this (minutes) count as "no relevant queue" (QUIET_PEAK_MIN in forecast-days.ts). */
    public const QUIET_MIN = 5;
    /** Today plus the next 7 days. */
    public const WEEK_DAYS = 8;
    /** Longest range a forecast-range marker renders. */
    public const MAX_RANGE_DAYS = 62;

    private const DOW = [
        'de' => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'],
        'en' => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    ];
    private const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    private const CAPTION_DIRS = [
        'de' => 'Richtung Süden = Stau vor dem Nordportal Göschenen, Richtung Norden = Stau vor dem Südportal Airolo',
        'en' => 'southbound = queue at the north portal Göschenen, northbound = queue at the south portal Airolo',
    ];

    /**
     * Reads and validates forecast-days.json. Returns the list of day rows keyed
     * by nothing (in date order), or null when the file is missing or invalid.
     *
     * @return list<array{date:string,north:array,south:array,holiday:?array}>|null
     */
    public static function load(string $path): ?array
    {
        if (!is_file($path)) {
            return null;
        }
        $json = json_decode((string) file_get_contents($path), true);
        if (!is_array($json) || !is_array($json['days'] ?? null)) {
            return null;
        }
        $rows = [];
        foreach ($json['days'] as $d) {
            $row = self::normaliseRow($d);
            if ($row !== null) {
                $rows[] = $row;
            }
        }
        usort($rows, static fn (array $a, array $b): int => strcmp($a['date'], $b['date']));
        return $rows;
    }

    /** Swiss-local "YYYY-MM-DD" of the given instant. */
    public static function swissToday(DateTimeImmutable $now): string
    {
        return $now->setTimezone(new DateTimeZone('Europe/Zurich'))->format('Y-m-d');
    }

    /** Lead sentence + table for today and the next 7 days; '' when there is no row for today. */
    public static function week(array $rows, string $lang, DateTimeImmutable $now): string
    {
        $lang = self::lang($lang);
        $todayIso = self::swissToday($now);
        $start = null;
        foreach ($rows as $i => $r) {
            if ($r['date'] === $todayIso) {
                $start = $i;
                break;
            }
        }
        if ($start === null) {
            return '';
        }
        $week = array_slice($rows, $start, self::WEEK_DAYS);
        $today = $week[0];
        $holiday = $today['holiday'] !== null ? ' (' . $today['holiday'][$lang] . ')' : '';
        $head = ($lang === 'de' ? 'Prognose heute, ' : 'Forecast today, ') . self::dayLabel($today['date'], $lang) . $holiday . ': ';
        $both = self::quiet($today['north']) && self::quiet($today['south'])
            ? I18n::t($lang, 'forecast.noQueues')
            : self::dirSentence('north', $today['north'], $lang) . ', ' . self::dirSentence('south', $today['south'], $lang) . '.';
        $lead = $head . $both . self::busiestSentence(
            array_slice($week, 1),
            $lang,
            $lang === 'de' ? 'Stärkster Tag der nächsten 7 Tage' : 'Busiest of the next 7 days',
        );
        $caption = $lang === 'de'
            ? 'Erwartete Spitzenwartezeit pro Tag, heute und die nächsten 7 Tage (' . self::CAPTION_DIRS['de'] . ')'
            : 'Expected peak waiting time per day, today and the next 7 days (' . self::CAPTION_DIRS['en'] . ')';
        return '<div class="fc-ssr"><p class="fc-ssr__lead">' . self::esc($lead) . '</p>'
            . self::table($week, $lang, $todayIso, $caption) . '</div>';
    }

    /** Table for $from..$to (inclusive), skipping days before today; '' when nothing is left. */
    public static function range(array $rows, string $lang, DateTimeImmutable $now, string $from, string $to): string
    {
        $lang = self::lang($lang);
        if (!self::isIsoDate($from) || !self::isIsoDate($to) || $from > $to) {
            return '';
        }
        $todayIso = self::swissToday($now);
        $lo = $from < $todayIso ? $todayIso : $from;
        $in = array_values(array_filter($rows, static fn (array $r): bool => $r['date'] >= $lo && $r['date'] <= $to));
        $in = array_slice($in, 0, self::MAX_RANGE_DAYS);
        if ($in === []) {
            return '';
        }
        $span = self::dayLabel($in[0]['date'], $lang) . '–' . self::dayLabel($in[count($in) - 1]['date'], $lang);
        $busiest = self::busiestSentence($in, $lang, $lang === 'de' ? 'stärkster Tag' : 'busiest day');
        $lead = ($lang === 'de' ? 'Prognose ' : 'Forecast ') . $span
            . ($busiest !== '' ? ',' . $busiest : ($lang === 'de' ? ': keine nennenswerten Staus erwartet.' : ': no relevant queues expected.'));
        $caption = $lang === 'de'
            ? 'Erwartete Spitzenwartezeit pro Tag, ' . $span . ' (' . self::CAPTION_DIRS['de'] . ')'
            : 'Expected peak waiting time per day, ' . $span . ' (' . self::CAPTION_DIRS['en'] . ')';
        return '<div class="fc-ssr"><p class="fc-ssr__lead">' . self::esc($lead) . '</p>'
            . self::table($in, $lang, $todayIso, $caption) . '</div>';
    }

    // ── internals ────────────────────────────────────────────────────────────

    private static function normaliseRow(mixed $d): ?array
    {
        if (!is_array($d) || !is_string($d['date'] ?? null) || !self::isIsoDate($d['date'])) {
            return null;
        }
        $dir = static function (mixed $p): ?array {
            if (!is_array($p) || !is_numeric($p['peakMin'] ?? null)) {
                return null;
            }
            $hour = $p['peakHour'] ?? null;
            return [
                'peakMin' => max(0, (int) round((float) $p['peakMin'])),
                'peakHour' => is_numeric($hour) && (int) $hour >= 0 && (int) $hour <= 23 ? (int) $hour : null,
            ];
        };
        $north = $dir($d['north'] ?? null);
        $south = $dir($d['south'] ?? null);
        if ($north === null || $south === null) {
            return null;
        }
        $h = $d['holiday'] ?? null;
        $holiday = is_array($h) && is_string($h['de'] ?? null) && is_string($h['en'] ?? null)
            ? ['de' => $h['de'], 'en' => $h['en']]
            : null;
        return ['date' => $d['date'], 'north' => $north, 'south' => $south, 'holiday' => $holiday];
    }

    private static function isIsoDate(string $s): bool
    {
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m)) {
            return false;
        }
        return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    private static function lang(string $lang): string
    {
        return $lang === 'de' ? 'de' : 'en';
    }

    private static function esc(string $s): string
    {
        // Same entities as esc() in forecast-days.ts (' -> &#039;).
        return htmlspecialchars($s, ENT_QUOTES | ENT_HTML401, 'UTF-8');
    }

    private static function dayLabel(string $iso, string $lang): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $iso));
        $dow = (int) (new DateTimeImmutable(sprintf('%04d-%02d-%02d', $y, $m, $d), new DateTimeZone('UTC')))->format('w');
        return $lang === 'de'
            ? sprintf('%s %02d.%02d.', self::DOW['de'][$dow], $d, $m)
            : sprintf('%s %d %s', self::DOW['en'][$dow], $d, self::MONTHS_EN[$m - 1]);
    }

    private static function hourLabel(int $h, string $lang): string
    {
        return $lang === 'de' ? $h . ' Uhr' : sprintf('%02d:00', $h);
    }

    private static function quiet(array $p): bool
    {
        return $p['peakMin'] < self::QUIET_MIN;
    }

    private static function dirName(string $dir, string $lang): string
    {
        return I18n::t($lang, $dir === 'north' ? 'dir.south' : 'dir.north');
    }

    private static function lowerFirst(string $s, string $lang): string
    {
        return $lang === 'de' ? $s : strtolower($s);
    }

    private static function dirSentence(string $dir, array $p, string $lang): string
    {
        $name = self::lowerFirst(self::dirName($dir, $lang), $lang);
        if (self::quiet($p)) {
            return $name . ($lang === 'de' ? ' kein nennenswerter Stau' : ' no relevant queue');
        }
        $at = $p['peakHour'] === null ? '' : ($lang === 'de' ? ' um ' : ' around ') . self::hourLabel($p['peakHour'], $lang);
        return $name . ($lang === 'de' ? ' Spitze ca. ' . $p['peakMin'] . ' Min' : ' peak approx. ' . $p['peakMin'] . ' min') . $at;
    }

    private static function cell(array $p, string $lang): string
    {
        if (self::quiet($p)) {
            return $lang === 'de'
                ? 'kaum Stau (unter ' . self::QUIET_MIN . ' Min)'
                : 'little or none (under ' . self::QUIET_MIN . ' min)';
        }
        $at = $p['peakHour'] === null ? '' : ' · ' . self::hourLabel($p['peakHour'], $lang);
        return ($lang === 'de' ? 'ca. ' . $p['peakMin'] . ' Min' : 'approx. ' . $p['peakMin'] . ' min') . $at;
    }

    private static function busiestSentence(array $rows, string $lang, string $prefix): string
    {
        $best = null;
        foreach ($rows as $row) {
            foreach (['north', 'south'] as $dir) {
                if ($best === null || $row[$dir]['peakMin'] > $best['min']) {
                    $best = ['row' => $row, 'dir' => $dir, 'min' => $row[$dir]['peakMin']];
                }
            }
        }
        if ($best === null || $best['min'] < self::QUIET_MIN) {
            return '';
        }
        $name = self::lowerFirst(self::dirName($best['dir'], $lang), $lang);
        return ' ' . $prefix . ': ' . self::dayLabel($best['row']['date'], $lang)
            . ($lang === 'de' ? ' (' . $name . ' ca. ' . $best['min'] . ' Min).' : ' (' . $name . ' approx. ' . $best['min'] . ' min).');
    }

    private static function table(array $rows, string $lang, string $todayIso, string $caption): string
    {
        $body = '';
        foreach ($rows as $r) {
            $today = $r['date'] === $todayIso ? ($lang === 'de' ? 'Heute, ' : 'Today, ') : '';
            $holiday = $r['holiday'] !== null ? ' <small>' . self::esc($r['holiday'][$lang]) . '</small>' : '';
            $body .= '<tr><th scope="row"><time datetime="' . self::esc($r['date']) . '">' . $today
                . self::esc(self::dayLabel($r['date'], $lang)) . '</time>' . $holiday . '</th>'
                . '<td>' . self::esc(self::cell($r['north'], $lang)) . '</td><td>' . self::esc(self::cell($r['south'], $lang)) . '</td></tr>';
        }
        return '<div class="table-scroll fc-ssr__scroll"><table class="data-table fc-ssr__table">'
            . '<caption>' . self::esc($caption) . '</caption>'
            . '<thead><tr><th scope="col">' . ($lang === 'de' ? 'Tag' : 'Day') . '</th><th scope="col">'
            . self::esc(self::dirName('north', $lang)) . '</th><th scope="col">' . self::esc(self::dirName('south', $lang)) . '</th></tr></thead>'
            . '<tbody>' . $body . '</tbody></table></div>';
    }
}
