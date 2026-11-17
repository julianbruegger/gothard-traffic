<?php

declare(strict_types=1);

require_once __DIR__ . '/I18n.php';
require_once __DIR__ . '/Format.php';
require_once __DIR__ . '/ForecastTable.php';

/**
 * Injects live values into the statically-built Astro HTML before it's served,
 * so search engines and AI crawlers (which mostly don't execute JavaScript)
 * see real, current content and structured data instead of an empty shell.
 * Client-side JS (live.ts) re-does the same DOM updates for visitors, then
 * keeps polling for fresh data every 60s.
 *
 * index.php routes EVERY page through here, so any page may use these markers:
 *
 *   Live snapshot (filled from the latest DB row; always replaced, empty when
 *   unknown, so a value baked into the build never survives as "current"):
 *     <!--SSR:summary-->…<!--/SSR-->          one-sentence status summary
 *     <!--SSR:status-label-->…<!--/SSR-->     tunnel status label
 *     <!--SSR:updated-human-->…<!--/SSR-->    "12.11.2026, 19:42"
 *     <!--SSR:{north|south}-{queue|wait|trend|cause}-->…<!--/SSR-->
 *         queue/wait read "0 km" / "0 Min" when the reading reports no queue
 *         (Format::portalFigures), "–" only without a usable reading
 *     <!--SSR:pass-status-label-->…<!--/SSR-->, <!--SSR:pass-note-->…<!--/SSR-->
 *     id-based: status-badge / pass-badge (data-status), hero-updated
 *     (datetime), {side}-meter (style width), {side}-cause-row, {side}-free,
 *     {side}-trend, pass-note-row (hidden), <section id="planned-closures">.
 *   Each marker/id is filled once (the first occurrence on the page).
 *
 *   24 h table (option 'history': DB rows of SnapshotStore::history()):
 *     <!--SSR:trend-table-->…<!--/SSR-->
 *         one <tr> per Swiss-time hour that has readings (max queue per side,
 *         worst status), at most 24 rows; empty without history. The full
 *         per-reading table is rendered by live.ts when the <details> opens.
 *
 *   Forecast (from forecast-days.json, built with the browser's model; see
 *   ForecastTable.php). Empty when the file is missing or has no row for today:
 *     <!--SSR:forecast-week-->…<!--/SSR-->
 *         lead sentence + table for today and the next 7 days (Swiss time)
 *     <!--SSR:forecast-range:YYYY-MM-DD:YYYY-MM-DD-->…<!--/SSR-->
 *         lead sentence + table for that inclusive date range (days before
 *         today are skipped, at most 62 days), e.g. Christmas or Easter pages.
 *   The content between the markers is the build-time fallback and is always
 *   replaced; it must not itself contain "<!--/SSR-->". In Astro, emit the
 *   marker with <Fragment set:html={...} /> (forecastWeekHtml /
 *   forecastRangeHtml in site/src/lib/forecast-days.ts render the fallback).
 *
 * Head rewriting (<title>, meta description/og/twitter, canonical, html lang,
 * Dataset JSON-LD) only happens with option 'head' => true (the two home
 * pages); every other page keeps the head Astro built for it.
 */
final class Ssr
{
    private const META_KEYS = [
        'description' => 'name',
        'og:title' => 'property',
        'og:description' => 'property',
        'og:url' => 'property',
        'twitter:title' => 'name',
        'twitter:description' => 'name',
    ];

    /**
     * @param array{head?: bool, forecast?: ?array, history?: ?array, now?: DateTimeImmutable} $options
     *   head      rewrite title/meta/canonical/html lang/JSON-LD (default true; home pages)
     *   forecast  day rows from ForecastTable::load() (null: forecast markers are emptied)
     *   history   snapshot rows, oldest first (SnapshotStore::history); null/[]: trend table emptied
     *   now       reference time for the forecast markers (default: current time)
     */
    public static function render(string $html, array $data, string $lang, string $canonicalUrl = '', array $options = []): string
    {
        if ($options['head'] ?? true) {
            $html = self::renderHead($html, $data, $lang, $canonicalUrl);
        }
        $html = self::renderLive($html, $data, $lang);
        $html = self::renderTrendTable($html, $options['history'] ?? null, $lang);
        return self::renderForecast(
            $html,
            $options['forecast'] ?? null,
            $lang,
            $options['now'] ?? new DateTimeImmutable('now', new DateTimeZone('UTC')),
        );
    }

    /** True when the page contains any marker or element filled from the DB snapshot. */
    public static function needsSnapshot(string $html): bool
    {
        return (bool) preg_match('/<!--SSR:(?!forecast-)|\sid="(?:planned-closures|status-badge|pass-badge|hero-updated)"/', $html);
    }

    /** True when the page contains the 24 h table marker (index.php then loads the history). */
    public static function needsHistory(string $html): bool
    {
        return str_contains($html, '<!--SSR:trend-table-->');
    }

    /** True when the page contains a forecast marker. */
    public static function needsForecast(string $html): bool
    {
        return str_contains($html, '<!--SSR:forecast-');
    }

    private static function renderForecast(string $html, ?array $rows, string $lang, DateTimeImmutable $now): string
    {
        if (!self::needsForecast($html)) {
            return $html;
        }
        $html = preg_replace_callback(
            '/<!--SSR:forecast-week-->.*?<!--\/SSR-->/s',
            static fn (array $m): string => '<!--SSR:forecast-week-->'
                . ($rows !== null ? ForecastTable::week($rows, $lang, $now) : '') . '<!--/SSR-->',
            $html,
        ) ?? $html;
        return preg_replace_callback(
            '/<!--SSR:forecast-range:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})-->.*?<!--\/SSR-->/s',
            static fn (array $m): string => '<!--SSR:forecast-range:' . $m[1] . ':' . $m[2] . '-->'
                . ($rows !== null ? ForecastTable::range($rows, $lang, $now, $m[1], $m[2]) : '') . '<!--/SSR-->',
            $html,
        ) ?? $html;
    }

    private static function renderHead(string $html, array $data, string $lang, string $canonicalUrl): string
    {
        // Keep <title> and <meta description> evergreen and keyword-focused — the
        // SAME stable strings the static Astro build emits. We deliberately do NOT
        // splice the live queue/wait numbers (Format::summary) in here: search
        // engines crawl a live-traffic page only every few weeks, so any volatile
        // value baked into the snippet gets frozen and shown as "current" long
        // after it's wrong. The live figures still reach crawlers through the
        // visible body markers and the JSON-LD variableMeasured block below.
        $title = I18n::t($lang, 'site.title') . ' – ' . I18n::t($lang, 'site.tagline');
        $description = I18n::t($lang, 'meta.description');

        $html = preg_replace('/<title>.*?<\/title>/s', '<title>' . htmlspecialchars($title, ENT_QUOTES) . '</title>', $html, 1);
        $html = self::replaceMeta($html, 'description', $description);
        $html = self::replaceMeta($html, 'og:title', $title);
        $html = self::replaceMeta($html, 'og:description', $description);
        $html = self::replaceMeta($html, 'og:url', $canonicalUrl);
        $html = self::replaceMeta($html, 'twitter:title', $title);
        $html = self::replaceMeta($html, 'twitter:description', $description);
        $html = self::replaceLinkHref($html, 'canonical', $canonicalUrl);

        $html = preg_replace(
            '/<html lang="[a-z]{2}" data-lang="[a-z]{2}">/',
            '<html lang="' . $lang . '" data-lang="' . $lang . '">',
            $html,
            1,
        );

        return self::replaceJsonLd($html, $data, $lang, $canonicalUrl, $description);
    }

    private static function renderLive(string $html, array $data, string $lang): string
    {
        if (!self::needsSnapshot($html)) {
            return $html;
        }
        $tunnel = $data['tunnel'] ?? [];
        $status = (string) ($tunnel['status'] ?? 'unknown');
        $html = self::replaceMarker($html, 'status-label', Format::statusLabel((string) ($tunnel['status'] ?? 'unknown'), $lang));
        $html = self::replaceMarker($html, 'summary', Format::summary($data, $lang));
        $html = self::replaceMarker($html, 'updated-human', Format::updated($data['updated'] ?? null, $lang));

        // Every marker is ALWAYS replaced (empty string when null) so a value baked
        // into the static build can never survive as a stale "current" value.
        foreach (['north', 'south'] as $side) {
            $portal = $tunnel[$side] ?? [];
            ['queueKm' => $queue, 'waitMinutes' => $wait] = Format::portalFigures($data, $side);
            $cause = trim((string) ($portal['cause'] ?? ''));

            $html = self::replaceMarker($html, "{$side}-queue", Format::queue($queue, $lang));
            // Closed without a reported wait: say so instead of "0 Min".
            $html = self::replaceMarker($html, "{$side}-wait", $status === 'closed' && $wait === null
                ? Format::statusLabel('closed', $lang)
                : Format::wait($queue, $wait, $lang));
            // The static build bakes no trend (no history); never leave one behind.
            $html = self::replaceMarker($html, "{$side}-trend", '');
            $html = self::setHidden($html, "{$side}-trend", true);
            $html = self::replaceMarker($html, "{$side}-cause", $cause);
            $html = self::setHidden($html, "{$side}-cause-row", $cause === '');
            $free = $queue !== null && $queue <= 0 && $status !== 'closed';
            $html = self::setHidden($html, "{$side}-free", !$free);
            $html = self::setStyleWidth($html, "{$side}-meter", self::meterPercent($queue));
        }

        $pass = $data['pass'] ?? [];
        $html = self::replaceMarker($html, 'pass-status-label', Format::passStatusLabel((string) ($pass['status'] ?? 'unknown'), $lang));
        $note = trim((string) ($pass['note'] ?? ''));
        $html = self::replaceMarker($html, 'pass-note', $note);
        $html = self::setHidden($html, 'pass-note-row', $note === '');

        $html = self::replaceAttr($html, 'status-badge', 'data-status', (string) ($tunnel['status'] ?? 'unknown'));
        $html = self::replaceAttr($html, 'pass-badge', 'data-status', (string) ($pass['status'] ?? 'unknown'));
        $html = self::replaceAttr($html, 'hero-updated', 'datetime', (string) ($data['updated'] ?? ''));

        $html = self::renderPlannedClosures($html, $tunnel['plannedClosures'] ?? [], $lang);

        return $html;
    }

    /** Worst first: an hour shows the worst status seen in it. */
    private const STATUS_RANK = ['closed' => 4, 'restricted' => 3, 'congested' => 2, 'open' => 1, 'unknown' => 0];

    /**
     * Hourly summary of the last 24 h (Swiss time): one row per hour that has
     * readings, max queue per side (NULL = no queue reported = 0 km) and the
     * worst status. Never more than 24 rows, never a row without data.
     */
    private static function renderTrendTable(string $html, ?array $rows, string $lang): string
    {
        if (!self::needsHistory($html)) {
            return $html;
        }
        $tz = new DateTimeZone('Europe/Zurich');
        $hours = [];
        foreach ($rows ?? [] as $row) {
            if (!is_array($row) || empty($row['fetched_at'])) {
                continue;
            }
            try {
                $t = (new DateTimeImmutable((string) $row['fetched_at'], new DateTimeZone('UTC')))->setTimezone($tz);
            } catch (Exception) {
                continue;
            }
            $key = $t->format('Y-m-d H');
            $status = (string) ($row['tunnel_status'] ?? 'unknown');
            $h = $hours[$key] ?? ['start' => $t->setTime((int) $t->format('G'), 0), 'north' => 0.0, 'south' => 0.0, 'status' => 'unknown'];
            $h['north'] = max($h['north'], (float) ($row['north_queue_km'] ?? 0));
            $h['south'] = max($h['south'], (float) ($row['south_queue_km'] ?? 0));
            if ((self::STATUS_RANK[$status] ?? 0) > (self::STATUS_RANK[$h['status']] ?? 0)) {
                $h['status'] = $status;
            }
            $hours[$key] = $h;
        }
        ksort($hours);
        $hours = array_slice($hours, -24);

        $out = '';
        foreach ($hours as $h) {
            $start = $h['start'];
            $end = $start->modify('+1 hour');
            $label = ($lang === 'de' ? $start->format('d.m.') : $start->format('j M')) . ', '
                . $start->format('H:i') . '–' . $end->format('H:i');
            $out .= '<tr' . ($h['status'] === 'closed' ? ' data-closed=""' : '') . '>'
                . '<td><time datetime="' . $start->format(DateTimeInterface::ATOM) . '">' . htmlspecialchars($label, ENT_QUOTES) . '</time></td>'
                . '<td class="num">' . htmlspecialchars(Format::queue($h['north'], $lang), ENT_QUOTES) . '</td>'
                . '<td class="num">' . htmlspecialchars(Format::queue($h['south'], $lang), ENT_QUOTES) . '</td>'
                . '<td>' . htmlspecialchars(Format::statusLabel($h['status'], $lang), ENT_QUOTES) . '</td>'
                . '</tr>';
        }
        return preg_replace_callback(
            '/<!--SSR:trend-table-->.*?<!--\/SSR-->/s',
            static fn (): string => '<!--SSR:trend-table-->' . $out . '<!--/SSR-->',
            $html,
            1,
        ) ?? $html;
    }

    /** Same 0-15 km scale as the client-side meter. */
    private static function meterPercent(?float $km): float
    {
        if ($km === null || $km <= 0) {
            return 0.0;
        }
        return round(min($km, 15.0) / 15.0 * 100, 1);
    }

    /** Adds or removes the boolean `hidden` attribute on the element with the given id (no-op if absent). */
    private static function setHidden(string $html, string $id, bool $hidden): string
    {
        return self::withTag($html, $id, static fn (string $tag): string => self::setTagAttr($tag, 'hidden', $hidden ? '' : null, true));
    }

    private static function setStyleWidth(string $html, string $id, float $percent): string
    {
        $style = 'width:' . rtrim(rtrim(number_format($percent, 1, '.', ''), '0'), '.') . '%';
        $style = $style === 'width:%' ? 'width:0%' : $style;
        return self::withTag($html, $id, static fn (string $tag): string => self::setTagAttr($tag, 'style', $style));
    }

    /** Applies $fn to the (first) start tag carrying id="$id"; no-op if absent. */
    private static function withTag(string $html, string $id, callable $fn): string
    {
        $pattern = '/<[a-zA-Z][a-zA-Z0-9-]*\s[^>]*(?<=\s)id="' . preg_quote($id, '/') . '"[^>]*>/s';
        return preg_replace_callback($pattern, static fn (array $m): string => $fn($m[0]), $html, 1) ?? $html;
    }

    /**
     * Sets ($value string) or removes ($value null) one attribute of a single
     * start tag. Matches every serialisation of it: attr="x", attr='x', attr=x
     * and the bare/boolean form `attr` that Astro's compressHTML emits for empty
     * values (e.g. `<time datetime>`). The first occurrence is replaced in place,
     * any further duplicates are dropped; quoted values of other attributes are
     * consumed whole, so text inside them can never match.
     */
    private static function setTagAttr(string $tag, string $attr, ?string $value, bool $bare = false): string
    {
        $render = ' ' . $attr . ($bare ? '' : '="' . htmlspecialchars((string) $value, ENT_QUOTES) . '"');
        $done = false;
        $tag = preg_replace_callback(
            '/\s+([^\s"\'>\/=]+)(?:\s*=\s*(?:"[^"]*"|\'[^\']*\'|[^\s"\'=<>`]+))?/',
            static function (array $m) use ($attr, $value, $render, &$done): string {
                if (strcasecmp($m[1], $attr) !== 0) {
                    return $m[0];
                }
                if ($value === null || $done) {
                    return '';
                }
                $done = true;
                return $render;
            },
            $tag,
        ) ?? $tag;
        if ($value !== null && !$done) {
            $tag = preg_replace_callback('/\s*(\/?>)$/', static fn (array $m): string => $render . $m[1], $tag, 1) ?? $tag;
        }
        return $tag;
    }

    /** Fills the planned-closures banner (escaped) and toggles its `hidden` attribute. */
    private static function renderPlannedClosures(string $html, array $closures, string $lang): string
    {
        $items = '';
        foreach ($closures as $c) {
            if (!is_array($c)) {
                continue;
            }
            $items .= '<div class="closure-banner__item" role="alert">'
                . '<span class="closure-banner__icon" aria-hidden="true">⚠</span>'
                . '<div class="closure-banner__text">'
                . '<strong class="closure-banner__title">' . htmlspecialchars(Format::closureTitle($c, $lang), ENT_QUOTES) . '</strong>'
                . '<span class="closure-banner__detail">' . htmlspecialchars(Format::closureDetail($c, $lang), ENT_QUOTES) . '</span>'
                . '</div></div>';
        }
        $pattern = '/(<section\b[^>]*\bid="planned-closures"[^>]*>)(.*?)(<\/section>)/s';
        $html = preg_replace_callback($pattern, static fn (array $m): string => $m[1] . $items . $m[3], $html, 1) ?? $html;
        return self::setHidden($html, 'planned-closures', $items === '');
    }

    private static function replaceMarker(string $html, string $key, string $value): string
    {
        $pattern = '/<!--SSR:' . preg_quote($key, '/') . '-->.*?<!--\/SSR-->/s';
        $replacement = '<!--SSR:' . $key . '-->' . htmlspecialchars($value, ENT_QUOTES) . '<!--/SSR-->';
        return preg_replace($pattern, str_replace('\\', '\\\\', $replacement), $html, 1) ?? $html;
    }

    private static function replaceAttr(string $html, string $id, string $attr, string $value): string
    {
        return self::withTag($html, $id, static fn (string $tag): string => self::setTagAttr($tag, $attr, $value));
    }

    private static function replaceMeta(string $html, string $key, string $value): string
    {
        $attr = self::META_KEYS[$key] ?? 'name';
        $pattern = '/(<meta[^>]*' . preg_quote($attr, '/') . '="' . preg_quote($key, '/') . '"[^>]*content=")[^"]*("[^>]*>)/is';
        $escaped = htmlspecialchars($value, ENT_QUOTES);
        return preg_replace($pattern, '${1}' . str_replace('$', '\\$', $escaped) . '${2}', $html, 1) ?? $html;
    }

    private static function replaceLinkHref(string $html, string $rel, string $href): string
    {
        $pattern = '/(<link[^>]*rel="' . preg_quote($rel, '/') . '"[^>]*href=")[^"]*("[^>]*>)/is';
        return preg_replace($pattern, '${1}' . htmlspecialchars($href, ENT_QUOTES) . '${2}', $html, 1) ?? $html;
    }

    private static function replaceJsonLd(string $html, array $data, string $lang, string $canonicalUrl, string $description): string
    {
        $origin = preg_match('#^https?://[^/]+#', $canonicalUrl, $m) ? $m[0] : '';
        // Numeric readings only when known (never null); status strings always.
        $measured = [];
        foreach (['north' => 'northPortal', 'south' => 'southPortal'] as $side => $prefix) {
            $fig = Format::portalFigures($data, $side);
            if ($fig['queueKm'] !== null) {
                $measured[] = ['@type' => 'PropertyValue', 'name' => $prefix . 'QueueLengthKm', 'value' => $fig['queueKm'], 'unitCode' => 'KMT', 'unitText' => 'km'];
            }
            if ($fig['waitMinutes'] !== null) {
                $measured[] = ['@type' => 'PropertyValue', 'name' => $prefix . 'WaitMinutes', 'value' => $fig['waitMinutes'], 'unitCode' => 'MIN', 'unitText' => 'min'];
            }
        }
        $measured[] = ['@type' => 'PropertyValue', 'name' => 'tunnelStatus', 'value' => (string) ($data['tunnel']['status'] ?? 'unknown')];
        $measured[] = ['@type' => 'PropertyValue', 'name' => 'passStatus', 'value' => (string) ($data['pass']['status'] ?? 'unknown')];

        $ld = array_filter([
            '@context' => 'https://schema.org',
            '@type' => 'Dataset',
            'name' => 'Gotthard Tunnel & Pass Traffic Status',
            'description' => $description,
            'url' => $canonicalUrl,
            'dateModified' => $data['updated'] ?? null,
            'isAccessibleForFree' => true,
            'license' => $origin . ($lang === 'de' ? '/daten' : '/en/data'),
            'creator' => [
                '@type' => 'Organization',
                'name' => 'Gotthard Traffic Live',
                'url' => $origin . '/',
            ],
            'isBasedOn' => 'https://opentransportdata.swiss/en/road-traffic/',
            'variableMeasured' => $measured,
            'distribution' => [
                ['@type' => 'DataDownload', 'encodingFormat' => 'application/json', 'contentUrl' => $origin . '/api/gotthard.php'],
                ['@type' => 'DataDownload', 'encodingFormat' => 'application/json', 'contentUrl' => $origin . '/api/history.php'],
            ],
        ], static fn ($v): bool => $v !== null);
        $json = json_encode($ld, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $pattern = '/<script type="application\/ld\+json" id="ld-traffic">.*?<\/script>/s';
        $replacement = '<script type="application/ld+json" id="ld-traffic">' . $json . '</script>';
        return preg_replace($pattern, str_replace('\\', '\\\\', $replacement), $html, 1) ?? $html;
    }
}
