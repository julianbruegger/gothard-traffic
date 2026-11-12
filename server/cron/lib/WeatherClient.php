<?php

declare(strict_types=1);

final class WeatherException extends RuntimeException
{
}

/**
 * Weather at the two Gotthard portals from Open-Meteo (free, no API key).
 * Collected alongside the traffic snapshots so jams can later be correlated
 * with temperature, rain and snow from our own history.
 */
final class WeatherClient
{
    /** Portal coordinates: Göschenen (north), Airolo (south). */
    public const PORTALS = [
        'north' => ['lat' => 46.668, 'lon' => 8.589],
        'south' => ['lat' => 46.529, 'lon' => 8.608],
    ];

    private const BASE = 'https://api.open-meteo.com/v1/forecast';

    public function __construct(private readonly array $config = [])
    {
    }

    /**
     * The last few COMPLETED hours (full-hour sums, UTC) for every portal.
     * Replaces fetchCurrent(), whose "current" block is a 15-minute interval
     * and would store a quarter of the hourly precipitation/snowfall.
     *
     * @return array<string, list<array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int}>>
     */
    public function fetchRecentHours(int $hours = 3): array
    {
        $out = [];
        foreach (self::PORTALS as $portal => $c) {
            $json = $this->get(self::BASE . '?latitude=' . $c['lat'] . '&longitude=' . $c['lon']
                . '&hourly=temperature_2m,precipitation,snowfall,weather_code&past_hours=' . max(1, min(24, $hours))
                . '&forecast_hours=0&timezone=UTC');
            $out[$portal] = self::completedHours(self::parseHourly($json), gmdate('Y-m-d H:00:00'));
        }
        return $out;
    }

    /**
     * Keep only hours strictly before $currentHour ("Y-m-d H:00:00", UTC): the
     * current hour is unfinished and anything later is a forecast.
     *
     * @param list<array{observedAt: string}> $rows
     * @return list<array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int}>
     */
    public static function completedHours(array $rows, string $currentHour): array
    {
        return array_values(array_filter(
            $rows,
            static fn (array $r): bool => $r['observedAt'] < $currentHour
        ));
    }

    /**
     * Current conditions for every portal (15-minute values: do NOT store the
     * precipitation/snowfall of this as an hourly sum).
     *
     * @return array<string, array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int}>
     */
    public function fetchCurrent(): array
    {
        $out = [];
        foreach (self::PORTALS as $portal => $c) {
            $json = $this->get(self::BASE . '?latitude=' . $c['lat'] . '&longitude=' . $c['lon']
                . '&current=temperature_2m,precipitation,snowfall,weather_code&timezone=UTC');
            $out[$portal] = self::parseCurrent($json);
        }
        return $out;
    }

    /**
     * Hourly history (past $days days, up to now) for every portal.
     *
     * @return array<string, list<array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int}>>
     */
    public function fetchHistory(int $days): array
    {
        $out = [];
        foreach (self::PORTALS as $portal => $c) {
            $json = $this->get(self::BASE . '?latitude=' . $c['lat'] . '&longitude=' . $c['lon']
                . '&hourly=temperature_2m,precipitation,snowfall,weather_code&past_days=' . max(1, min(92, $days))
                . '&forecast_days=1&timezone=UTC');
            // Today's remaining hours are forecasts, not observations: drop them.
            $cutoff = gmdate('Y-m-d H:00:00');
            $out[$portal] = array_values(array_filter(
                self::parseHourly($json),
                static fn (array $r): bool => $r['observedAt'] <= $cutoff
            ));
        }
        return $out;
    }

    /** @return array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int} */
    public static function parseCurrent(array $json): array
    {
        $cur = $json['current'] ?? null;
        if (!is_array($cur) || !isset($cur['time'])) {
            throw new WeatherException('No "current" block in weather response.');
        }
        return [
            'observedAt'    => self::hour((string) $cur['time']),
            'temperature'   => self::num($cur['temperature_2m'] ?? null),
            'precipitation' => self::num($cur['precipitation'] ?? null),
            'snowfall'      => self::num($cur['snowfall'] ?? null),
            'weatherCode'   => isset($cur['weather_code']) ? (int) $cur['weather_code'] : null,
        ];
    }

    /** @return list<array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int}> */
    public static function parseHourly(array $json): array
    {
        $h = $json['hourly'] ?? null;
        if (!is_array($h) || !isset($h['time']) || !is_array($h['time'])) {
            throw new WeatherException('No "hourly" block in weather response.');
        }
        $rows = [];
        foreach ($h['time'] as $i => $time) {
            $temp = self::num($h['temperature_2m'][$i] ?? null);
            $prec = self::num($h['precipitation'][$i] ?? null);
            if ($temp === null && $prec === null) {
                continue; // future hour without data
            }
            $rows[] = [
                'observedAt'    => self::hour((string) $time),
                'temperature'   => $temp,
                'precipitation' => $prec,
                'snowfall'      => self::num($h['snowfall'][$i] ?? null),
                'weatherCode'   => isset($h['weather_code'][$i]) ? (int) $h['weather_code'][$i] : null,
            ];
        }
        return $rows;
    }

    /** "2026-11-09T20:15" (UTC) → "2026-11-09 20:00:00" (top of the hour). */
    private static function hour(string $time): string
    {
        $dt = new DateTimeImmutable($time, new DateTimeZone('UTC'));
        return $dt->format('Y-m-d H:00:00');
    }

    private static function num(mixed $v): ?float
    {
        return is_numeric($v) ? (float) $v : null;
    }

    private function get(string $url): array
    {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 10,
            CURLOPT_USERAGENT      => 'gotthard-traffic-collector/1.0',
        ]);
        $body  = curl_exec($ch);
        $errno = curl_errno($ch);
        $error = curl_error($ch);
        $http  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);

        if ($errno !== 0) {
            throw new WeatherException("cURL error ({$errno}): {$error}");
        }
        if ($http < 200 || $http >= 300 || !is_string($body)) {
            throw new WeatherException("Unexpected HTTP status {$http}.");
        }
        $json = json_decode($body, true);
        if (!is_array($json)) {
            throw new WeatherException('Weather response is not valid JSON.');
        }
        return $json;
    }
}
