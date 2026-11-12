<?php

declare(strict_types=1);

/**
 * Tiny file-cached JSON proxy so the browser never talks to third parties.
 * Serves a fresh cache, otherwise fetches upstream; on upstream failure it
 * falls back to a stale cache entry if there is one.
 */
final class CachedProxy
{
    /** @return string|null raw JSON body, or null when unavailable */
    public static function fetch(string $url, string $cacheKey, int $ttl): ?string
    {
        $dir  = __DIR__ . '/../data/proxy';
        $file = $dir . '/' . preg_replace('/[^A-Za-z0-9_.-]/', '_', $cacheKey) . '.json';
        if (is_file($file) && (time() - (int) filemtime($file)) < $ttl) {
            return (string) file_get_contents($file);
        }

        $body = self::get($url);
        if ($body !== null) {
            if (!is_dir($dir)) {
                @mkdir($dir, 0775, true);
            }
            $tmp = $file . '.' . getmypid() . '.tmp';
            if (@file_put_contents($tmp, $body) !== false) {
                @rename($tmp, $file);
            }
            return $body;
        }
        return is_file($file) ? (string) file_get_contents($file) : null;
    }

    private static function get(string $url): ?string
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 8,
            CURLOPT_USERAGENT      => 'gotthard-traffic-proxy/1.0',
        ]);
        $body = curl_exec($ch);
        $http = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        if (!is_string($body) || $http < 200 || $http >= 300 || json_decode($body) === null) {
            return null;
        }
        return $body;
    }
}
