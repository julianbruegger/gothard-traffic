<?php

declare(strict_types=1);

/**
 * Lightweight per-day hit counter for search and AI crawlers, because the
 * host's access logs are not easily available. Stores only counts per UTC day,
 * bot name and request path in data/crawler-hits.json (no IPs, no full user
 * agents). Exposed in aggregate by api/crawlers.php.
 *
 * Usage (index.php, api/*.php):
 *   CrawlerLog::record($_SERVER['HTTP_USER_AGENT'] ?? '', $path);
 *
 * record() never throws and returns quickly for ordinary visitors (no file
 * access unless the user agent matches a known bot).
 */
final class CrawlerLog
{
    /** Days kept in the file. */
    public const KEEP_DAYS = 60;
    /** Distinct paths kept per bot and day; the rest count as "(other)". */
    private const MAX_PATHS = 25;

    /**
     * Bot name => user-agent substring (case-insensitive). More specific
     * tokens come first ("Applebot-Extended" before "Applebot").
     */
    public const BOTS = [
        'OAI-SearchBot'      => 'oai-searchbot',
        'ChatGPT-User'       => 'chatgpt-user',
        'GPTBot'             => 'gptbot',
        'Perplexity-User'    => 'perplexity-user',
        'PerplexityBot'      => 'perplexitybot',
        'Claude-SearchBot'   => 'claude-searchbot',
        'Claude-User'        => 'claude-user',
        'ClaudeBot'          => 'claudebot',
        'anthropic-ai'       => 'anthropic-ai',
        'Google-Extended'    => 'google-extended',
        'Googlebot'          => 'googlebot',
        'bingbot'            => 'bingbot',
        'Applebot-Extended'  => 'applebot-extended',
        'Applebot'           => 'applebot',
        'CCBot'              => 'ccbot',
        'Bytespider'         => 'bytespider',
        'meta-externalagent' => 'meta-externalagent',
        'DuckAssistBot'      => 'duckassistbot',
        'YandexBot'          => 'yandexbot',
    ];

    /** Known bot name for a user agent, or null. */
    public static function match(string $userAgent): ?string
    {
        if ($userAgent === '') {
            return null;
        }
        $ua = strtolower($userAgent);
        foreach (self::BOTS as $name => $token) {
            if (str_contains($ua, $token)) {
                return $name;
            }
        }
        return null;
    }

    public static function defaultFile(): string
    {
        return __DIR__ . '/../data/crawler-hits.json';
    }

    /** Counts one request by a known bot. Never throws. */
    public static function record(string $userAgent, string $path, ?string $file = null, ?DateTimeImmutable $now = null): void
    {
        try {
            $bot = self::match($userAgent);
            if ($bot === null) {
                return;
            }
            $file ??= self::defaultFile();
            $now ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
            $day = $now->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d');
            $path = self::normalizePath($path);

            $dir = dirname($file);
            if (!is_dir($dir)) {
                @mkdir($dir, 0775, true);
            }
            $fh = @fopen($file, 'c+');
            if ($fh === false) {
                return;
            }
            try {
                if (!flock($fh, LOCK_EX)) {
                    return;
                }
                $raw = stream_get_contents($fh);
                $data = is_string($raw) && $raw !== '' ? json_decode($raw, true) : null;
                $days = is_array($data['days'] ?? null) ? $data['days'] : [];

                $entry = is_array($days[$day][$bot] ?? null) ? $days[$day][$bot] : ['hits' => 0, 'paths' => []];
                $entry['hits'] = (int) ($entry['hits'] ?? 0) + 1;
                $paths = is_array($entry['paths'] ?? null) ? $entry['paths'] : [];
                if (!isset($paths[$path]) && count($paths) >= self::MAX_PATHS) {
                    $path = '(other)';
                }
                $paths[$path] = (int) ($paths[$path] ?? 0) + 1;
                $entry['paths'] = $paths;
                $days[$day][$bot] = $entry;

                // Keep the last KEEP_DAYS days only.
                $cutoff = $now->setTimezone(new DateTimeZone('UTC'))->modify('-' . (self::KEEP_DAYS - 1) . ' days')->format('Y-m-d');
                $days = array_filter($days, static fn ($k): bool => (string) $k >= $cutoff, ARRAY_FILTER_USE_KEY);
                ksort($days);

                $json = json_encode(['days' => $days], JSON_UNESCAPED_SLASHES);
                if ($json !== false) {
                    ftruncate($fh, 0);
                    rewind($fh);
                    fwrite($fh, $json);
                    fflush($fh);
                }
            } finally {
                @flock($fh, LOCK_UN);
                @fclose($fh);
            }
        } catch (Throwable) {
            // Measurement must never break a page or an API response.
        }
    }

    /**
     * Aggregate for api/crawlers.php: per day per bot (newest day first) for the
     * last $days days, plus totals per bot over that window.
     */
    public static function summary(int $days = 30, ?string $file = null, ?DateTimeImmutable $now = null): array
    {
        $file ??= self::defaultFile();
        $now ??= new DateTimeImmutable('now', new DateTimeZone('UTC'));
        $raw = is_file($file) ? @file_get_contents($file) : false;
        $data = is_string($raw) ? json_decode($raw, true) : null;
        $all = is_array($data['days'] ?? null) ? $data['days'] : [];

        $today = $now->setTimezone(new DateTimeZone('UTC'));
        $cutoff = $today->modify('-' . max(0, $days - 1) . ' days')->format('Y-m-d');
        $today = $today->format('Y-m-d');
        $out = [];
        $totals = [];
        foreach ($all as $day => $bots) {
            if ((string) $day < $cutoff || (string) $day > $today || !is_array($bots)) {
                continue;
            }
            foreach ($bots as $bot => $entry) {
                $hits = (int) ($entry['hits'] ?? 0);
                $paths = is_array($entry['paths'] ?? null) ? $entry['paths'] : [];
                arsort($paths);
                $out[(string) $day][(string) $bot] = ['hits' => $hits, 'paths' => $paths];
                $totals[(string) $bot] = ($totals[(string) $bot] ?? 0) + $hits;
            }
        }
        krsort($out);
        arsort($totals);
        return [
            'generated' => $now->format(DateTimeInterface::ATOM),
            'days'      => $days,
            'timezone'  => 'UTC',
            'bots'      => array_keys(self::BOTS),
            // Objects even when empty, so the JSON shape is stable.
            'totals'    => $totals === [] ? new stdClass() : $totals,
            'perDay'    => $out === [] ? new stdClass() : $out,
        ];
    }

    /** Path only (no query string), at most 120 characters. */
    private static function normalizePath(string $path): string
    {
        $p = parse_url($path, PHP_URL_PATH);
        $p = is_string($p) && $p !== '' ? $p : '/';
        $p = preg_replace('/[^\x21-\x7E]/', '', $p) ?? '/';
        return substr($p !== '' ? $p : '/', 0, 120);
    }
}
