<?php

declare(strict_types=1);

final class DatexFetchException extends RuntimeException
{
}

/**
 * Thin HTTP client for the opentransportdata.swiss / ASTRA DATEX II
 * "TrafficSituations" pull endpoint. Returns the raw XML body; parsing is
 * handled separately in TrafficParser so this class stays easy to unit-test.
 */
final class DatexClient
{
    public function __construct(private readonly array $config)
    {
    }

    /**
     * @return string raw XML response body
     * @throws DatexFetchException
     */
    public function fetchRaw(): string
    {
        $url = $this->config['api_url'];
        $headers = ['Accept: application/xml, text/xml'];

        $token = $this->config['api_token'] ?? '';
        if ($token !== '' && $token !== 'YOUR_API_TOKEN_HERE') {
            $headerName = $this->config['auth_header'] ?? 'Authorization';
            $prefix = $this->config['auth_prefix'] ?? '';
            $headers[] = "{$headerName}: {$prefix}{$token}";
        } else {
            throw new DatexFetchException('No API token configured (see config.example.php).');
        }

        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_USERAGENT => 'gotthard-traffic-scraper/1.0 (+https://github.com/)',
        ]);

        $body = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($errno !== 0) {
            throw new DatexFetchException("cURL error ({$errno}): {$error}");
        }
        if ($status < 200 || $status >= 300) {
            $snippet = substr((string) $body, 0, 300);
            throw new DatexFetchException("Unexpected HTTP status {$status}. Body starts with: {$snippet}");
        }
        if ($body === false || trim((string) $body) === '') {
            throw new DatexFetchException('Empty response body.');
        }

        return $body;
    }
}
