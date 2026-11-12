<?php

declare(strict_types=1);

require_once __DIR__ . '/I18n.php';
require_once __DIR__ . '/Format.php';

/**
 * Injects live values into the statically-built Astro HTML (dist/index.html)
 * before it's served, so search engines and AI crawlers (which mostly don't
 * execute JavaScript) see real, current content and structured data instead
 * of an empty shell. Client-side JS (live.ts) re-does the same DOM updates
 * for visitors, then keeps polling for fresh data every 60s.
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

    public static function render(string $html, array $data, string $lang, string $canonicalUrl): string
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

        $html = self::replaceJsonLd($html, $data, $lang, $canonicalUrl, $description);

        $tunnel = $data['tunnel'] ?? [];
        $html = self::replaceMarker($html, 'status-label', Format::statusLabel((string) ($tunnel['status'] ?? 'unknown'), $lang));
        $html = self::replaceMarker($html, 'summary', Format::summary($data, $lang));
        $html = self::replaceMarker($html, 'updated-human', Format::updated($data['updated'] ?? null, $lang));

        // Every marker is ALWAYS replaced (empty string when null) so a value baked
        // into the static build can never survive as a stale "current" value.
        foreach (['north', 'south'] as $side) {
            $portal = $tunnel[$side] ?? [];
            $queue = $portal['queueKm'] ?? null;
            $queue = $queue !== null ? (float) $queue : null;
            $wait = $portal['waitMinutes'] ?? null;
            $wait = $wait !== null ? (int) $wait : null;
            $cause = trim((string) ($portal['cause'] ?? ''));

            $html = self::replaceMarker($html, "{$side}-queue", Format::km($queue, $lang));
            $html = self::replaceMarker($html, "{$side}-wait", Format::minutes($wait, $lang));
            // The static build bakes no trend (no history); never leave one behind.
            $html = self::replaceMarker($html, "{$side}-trend", '');
            $html = self::setHidden($html, "{$side}-trend", true);
            $html = self::replaceMarker($html, "{$side}-cause", $cause);
            $html = self::setHidden($html, "{$side}-cause-row", $cause === '');
            $free = $queue !== null && $queue <= 0;
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
        $pattern = '/<[a-zA-Z0-9]+\s+[^>]*\bid="' . preg_quote($id, '/') . '"[^>]*>/s';
        return preg_replace_callback($pattern, static function (array $m) use ($hidden): string {
            $tag = preg_replace('/\s+hidden(?:=""|="hidden")?(?=[\s>\/])/', '', $m[0]) ?? $m[0];
            if ($hidden) {
                $tag = preg_replace('/(\s*\/?>)$/', ' hidden$1', $tag, 1) ?? $tag;
            }
            return $tag;
        }, $html, 1) ?? $html;
    }

    private static function setStyleWidth(string $html, string $id, float $percent): string
    {
        $pattern = '/<[a-zA-Z0-9]+\s+[^>]*\bid="' . preg_quote($id, '/') . '"[^>]*>/s';
        $style = 'width:' . rtrim(rtrim(number_format($percent, 1, '.', ''), '0'), '.') . '%';
        $style = $style === 'width:%' ? 'width:0%' : $style;
        return preg_replace_callback($pattern, static function (array $m) use ($style): string {
            $tag = $m[0];
            if (preg_match('/\sstyle="[^"]*"/', $tag)) {
                return preg_replace('/\sstyle="[^"]*"/', ' style="' . $style . '"', $tag, 1) ?? $tag;
            }
            return preg_replace('/(\s*\/?>)$/', ' style="' . $style . '"$1', $tag, 1) ?? $tag;
        }, $html, 1) ?? $html;
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
        $pattern = '/(<[a-zA-Z0-9]+\s+[^>]*\bid="' . preg_quote($id, '/') . '"[^>]*>)/s';
        return preg_replace_callback($pattern, static function (array $m) use ($attr, $value): string {
            $tag = $m[1];
            $escaped = htmlspecialchars($value, ENT_QUOTES);
            if (preg_match('/\b' . preg_quote($attr, '/') . '="[^"]*"/', $tag)) {
                return preg_replace('/\b' . preg_quote($attr, '/') . '="[^"]*"/', $attr . '="' . $escaped . '"', $tag, 1);
            }
            return preg_replace('/>$/', ' ' . $attr . '="' . $escaped . '">', $tag, 1);
        }, $html, 1) ?? $html;
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
        $ld = [
            '@context' => 'https://schema.org',
            '@type' => 'Dataset',
            'name' => 'Gotthard Tunnel & Pass Traffic Status',
            'description' => $description,
            'url' => $canonicalUrl,
            'dateModified' => $data['updated'] ?? null,
            'creator' => [
                '@type' => 'Organization',
                'name' => 'Gotthard Traffic Live',
            ],
            'isBasedOn' => [
                '@type' => 'Dataset',
                'name' => 'ASTRA / opentransportdata.swiss Traffic Situations',
                'url' => 'https://opentransportdata.swiss/en/road-traffic/',
            ],
            'variableMeasured' => [
                [
                    '@type' => 'PropertyValue',
                    'name' => 'northPortalQueueLengthKm',
                    'value' => $data['tunnel']['north']['queueKm'] ?? null,
                ],
                [
                    '@type' => 'PropertyValue',
                    'name' => 'northPortalWaitMinutes',
                    'value' => $data['tunnel']['north']['waitMinutes'] ?? null,
                ],
                [
                    '@type' => 'PropertyValue',
                    'name' => 'southPortalQueueLengthKm',
                    'value' => $data['tunnel']['south']['queueKm'] ?? null,
                ],
                [
                    '@type' => 'PropertyValue',
                    'name' => 'southPortalWaitMinutes',
                    'value' => $data['tunnel']['south']['waitMinutes'] ?? null,
                ],
                [
                    '@type' => 'PropertyValue',
                    'name' => 'tunnelStatus',
                    'value' => $data['tunnel']['status'] ?? 'unknown',
                ],
                [
                    '@type' => 'PropertyValue',
                    'name' => 'passStatus',
                    'value' => $data['pass']['status'] ?? 'unknown',
                ],
            ],
        ];
        $json = json_encode($ld, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        $pattern = '/<script type="application\/ld\+json" id="ld-traffic">.*?<\/script>/s';
        $replacement = '<script type="application/ld+json" id="ld-traffic">' . $json . '</script>';
        return preg_replace($pattern, str_replace('\\', '\\\\', $replacement), $html, 1) ?? $html;
    }
}
