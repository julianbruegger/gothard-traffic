<?php

declare(strict_types=1);

/**
 * IndexNow ping (Bing, Yandex, Seznam, ... share the endpoint): when the tunnel
 * status or the set of planned closures changes, tell search engines that the
 * live pages changed so they recrawl them soon.
 *
 * - The "signature" is the tunnel status plus the planned closures. A change
 *   against the last notified signature (or, on the first run, against the
 *   previous stored snapshot) triggers a ping.
 * - At most one ping per MIN_INTERVAL seconds. A change that falls inside the
 *   window stays pending and is sent once the window has passed.
 * - State lives in a small JSON file (default data/indexnow-state.json), like
 *   CollectorState.
 * - The HTTP sender is injectable so the logic is testable without network.
 *
 * Callers must treat every failure as non-fatal (fetch-traffic.php catches and
 * logs).
 */
final class IndexNow
{
    public const ENDPOINT = 'https://api.indexnow.org/indexnow';
    public const MIN_INTERVAL = 1800;
    /** Pages whose content follows the live status. */
    public const PATHS = ['/', '/en', '/sperrungen', '/en/closures'];

    /** @var callable(string, string): int */
    private $sender;

    /**
     * @param callable(string $url, string $jsonBody): int|null $sender returns the HTTP status (0 on transport error)
     */
    public function __construct(
        private readonly string $key,
        private readonly string $siteUrl,
        private readonly string $statePath,
        ?callable $sender = null,
    ) {
        $this->sender = $sender ?? [self::class, 'httpPost'];
    }

    /** IndexNow keys: 8-128 characters a-z, A-Z, 0-9 and "-". */
    public static function isValidKey(string $key): bool
    {
        return (bool) preg_match('/^[a-zA-Z0-9-]{8,128}$/', $key);
    }

    /**
     * Status + planned closures of a parsed result / mapped snapshot (both have
     * the same "tunnel" shape). Order and extra fields of closures do not matter.
     */
    public static function signature(?array $data): ?string
    {
        if ($data === null || !is_array($data['tunnel'] ?? null)) {
            return null;
        }
        $tunnel = $data['tunnel'];
        $closures = [];
        foreach (is_array($tunnel['plannedClosures'] ?? null) ? $tunnel['plannedClosures'] : [] as $c) {
            if (is_array($c)) {
                $closures[] = [self::normTime($c['from'] ?? null), self::normTime($c['to'] ?? null), (string) ($c['cause'] ?? '')];
            }
        }
        sort($closures);
        return (string) ($tunnel['status'] ?? 'unknown') . '|' . md5((string) json_encode($closures));
    }

    /** Same instant in any offset notation -> same string. */
    private static function normTime(mixed $v): string
    {
        if (!is_string($v) || $v === '') {
            return '';
        }
        try {
            return (string) (new DateTimeImmutable($v))->getTimestamp();
        } catch (Exception) {
            return $v;
        }
    }

    /** Full URLs to submit. */
    public function urls(): array
    {
        $base = rtrim($this->siteUrl, '/');
        return array_map(static fn (string $p): string => $p === '/' ? $base . '/' : $base . $p, self::PATHS);
    }

    /**
     * Decide and (maybe) ping.
     *
     * @param array      $current  this run's result (needs ['tunnel'])
     * @param array|null $previous the previous stored snapshot, mapped (baseline on the first run)
     * @return string 'invalid-key' | 'unchanged' | 'rate-limited' | 'pinged' | 'failed'
     */
    public function maybePing(array $current, ?array $previous, int $now): string
    {
        if (!self::isValidKey($this->key)) {
            return 'invalid-key';
        }
        $state = $this->loadState();
        $sig = self::signature($current);
        $baseline = $state['lastSignature'] ?? self::signature($previous);

        if ($baseline === null) {
            // First run ever, nothing to compare against: remember, don't ping.
            $state['lastSignature'] = $sig;
            $this->saveState($state);
            return 'unchanged';
        }
        if ($sig === $baseline) {
            if (!isset($state['lastSignature'])) {
                $state['lastSignature'] = $sig;
                $this->saveState($state);
            }
            return 'unchanged';
        }
        $lastPing = (int) ($state['lastPing'] ?? 0);
        if ($lastPing > 0 && $now - $lastPing < self::MIN_INTERVAL) {
            // Keep the old baseline so the change is still pending next run.
            if (!isset($state['lastSignature'])) {
                $state['lastSignature'] = $baseline;
                $this->saveState($state);
            }
            return 'rate-limited';
        }

        try {
            $code = (int) ($this->sender)(self::ENDPOINT, $this->payload());
        } catch (Throwable) {
            $code = 0;
        }
        // Every attempt counts for the rate limit, so a failing endpoint is not
        // hammered every 3 minutes; a failed ping stays pending.
        $state['lastPing'] = $now;
        $state['lastStatus'] = $code;
        $ok = $code >= 200 && $code < 300;
        if ($ok) {
            $state['lastSignature'] = $sig;
        } else {
            $state['lastSignature'] = $baseline;
        }
        $this->saveState($state);
        return $ok ? 'pinged' : 'failed';
    }

    public function payload(): string
    {
        $base = rtrim($this->siteUrl, '/');
        return (string) json_encode([
            'host'        => (string) parse_url($base, PHP_URL_HOST),
            'key'         => $this->key,
            'keyLocation' => $base . '/' . $this->key . '.txt',
            'urlList'     => $this->urls(),
        ], JSON_UNESCAPED_SLASHES);
    }

    /**
     * Writes <webroot>/<key>.txt (containing the key) when it is missing or
     * different, so the key can be verified. Returns true when the file is in place.
     */
    public function ensureKeyFile(string $webroot): bool
    {
        if (!self::isValidKey($this->key)) {
            return false;
        }
        $path = rtrim($webroot, '/') . '/' . $this->key . '.txt';
        if (is_file($path) && @file_get_contents($path) === $this->key) {
            return true;
        }
        $tmp = $path . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, $this->key) === false) {
            return false;
        }
        return @rename($tmp, $path);
    }

    private function loadState(): array
    {
        $raw = is_file($this->statePath) ? @file_get_contents($this->statePath) : false;
        $json = is_string($raw) ? json_decode($raw, true) : null;
        return is_array($json) ? $json : [];
    }

    private function saveState(array $state): void
    {
        $dir = dirname($this->statePath);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @file_put_contents($this->statePath, json_encode($state, JSON_UNESCAPED_SLASHES), LOCK_EX);
    }

    /** Default sender: POST JSON with short timeouts. Returns the HTTP status (0 on error). */
    public static function httpPost(string $url, string $body): int
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json; charset=utf-8'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_USERAGENT      => 'gotthard-traffic-indexnow/1.0',
        ]);
        curl_exec($ch);
        return (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    }
}
