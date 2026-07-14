<?php

declare(strict_types=1);

final class PassStatusException extends RuntimeException
{
}

/**
 * Secondary, advisory source for the Gotthard PASS road status, scraped from
 * the public status widget on alpen-paesse.ch. Used to cross-check and to fill
 * the pass status when the official ASTRA/DATEX feed carries no pass record
 * (typically in summer, when the pass is simply open).
 *
 * Deliberately defensive: the page also lists other passes further down, so we
 * only look at the current-status block at the top, anchored on the
 * "gültig seit" timestamp. Returns null if nothing can be determined; callers
 * treat any failure as non-fatal (DATEX remains authoritative).
 */
final class PassStatusClient
{
    private const DEFAULT_URL = 'https://www.alpen-paesse.ch/de/alpenpaesse/gotthardpass/';

    public function __construct(private readonly array $config)
    {
    }

    /**
     * @return array{status: string, note: ?string}|null
     */
    public function fetch(): ?array
    {
        $url = $this->config['pass_source_url'] ?? self::DEFAULT_URL;

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_USERAGENT => 'gotthard-traffic-scraper/1.0 (+https://github.com/)',
            CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml'],
        ]);
        $html = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $httpStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($errno !== 0) {
            throw new PassStatusException("cURL error ({$errno}): {$error}");
        }
        if ($httpStatus < 200 || $httpStatus >= 300) {
            throw new PassStatusException("Unexpected HTTP status {$httpStatus}.");
        }
        if (!is_string($html) || trim($html) === '') {
            throw new PassStatusException('Empty response body.');
        }

        return self::extract($html);
    }

    /**
     * @return array{status: string, note: ?string}|null
     */
    public static function extract(string $html): ?array
    {
        // Reduce to whitespace-collapsed plain text.
        $html = (string) preg_replace('#<(script|style)\b[^>]*>.*?</\1>#is', ' ', $html);
        $text = (string) preg_replace('#<[^>]+>#', ' ', $html);
        $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $text = trim((string) preg_replace('/\s+/u', ' ', $text));

        // The "gültig seit …" timestamp marks the end of the current-status
        // widget. Scope detection to the text *before* it so the pass table
        // lower on the page can't leak another pass's status in.
        $note = null;
        if (preg_match('/g[üu]ltig seit:?\s*([0-9]{1,2}\.[0-9]{1,2}\.[0-9]{2,4}(?:,?\s*[0-9]{1,2}[:.][0-9]{2})?)/ui', $text, $m) === 1) {
            $note = 'Alpen-Pässe, Stand ' . trim($m[1]);
            $anchor = mb_stripos($text, $m[0]);
            if ($anchor !== false) {
                $text = mb_substr($text, 0, $anchor);
            }
        } else {
            // No timestamp found — only trust the first ~1500 chars (top block).
            $text = mb_substr($text, 0, 1500);
        }

        $low = mb_strtolower($text);

        // Order matters: closed and restricted win over a stray "offen".
        if (self::containsAny($low, ['gesperrt', 'geschlossen', 'wintersperre', 'nicht befahrbar'])) {
            return ['status' => 'closed', 'note' => $note];
        }
        if (self::containsAny($low, ['schneeketten', 'eingeschränkt', 'nur mit', 'einspurig'])) {
            return ['status' => 'restricted', 'note' => $note];
        }
        if (str_contains($low, 'offen') || str_contains($low, 'befahrbar')) {
            return ['status' => 'open', 'note' => $note];
        }
        return null;
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
}
