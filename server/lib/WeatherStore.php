<?php

declare(strict_types=1);

/**
 * Hourly weather per portal in gotthard_weather (UTC, one row per
 * observed_at hour and portal).
 */
final class WeatherStore
{
    public function __construct(private readonly PDO $pdo)
    {
    }

    /** Has a row for this UTC hour ("Y-m-d H:00:00") already been stored? */
    public function hasHour(string $observedAt): bool
    {
        $stmt = $this->pdo->prepare('SELECT 1 FROM gotthard_weather WHERE observed_at = :t LIMIT 1');
        $stmt->execute([':t' => $observedAt]);
        return $stmt->fetchColumn() !== false;
    }

    /**
     * Insert or update one hour for one portal.
     *
     * @param array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float, weatherCode: ?int} $w
     */
    public function upsert(string $portal, array $w): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO gotthard_weather
               (observed_at, portal, temperature_c, precipitation_mm, snowfall_cm, weather_code)
             VALUES (:t, :portal, :temp, :prec, :snow, :code)
             ON DUPLICATE KEY UPDATE
               temperature_c = VALUES(temperature_c),
               precipitation_mm = VALUES(precipitation_mm),
               snowfall_cm = VALUES(snowfall_cm),
               weather_code = VALUES(weather_code)'
        );
        $stmt->execute([
            ':t'      => $w['observedAt'],
            ':portal' => $portal,
            ':temp'   => $w['temperature'],
            ':prec'   => $w['precipitation'],
            ':snow'   => $w['snowfall'],
            ':code'   => $w['weatherCode'],
        ]);
    }

    /**
     * Weather rows of the last $days days, oldest first.
     *
     * @return list<array<string, mixed>>
     */
    public function history(int $days = 30): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT observed_at, portal, temperature_c, precipitation_mm, snowfall_cm, weather_code
               FROM gotthard_weather
              WHERE observed_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)
              ORDER BY observed_at ASC'
        );
        $stmt->bindValue(':days', $days, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }

    /**
     * Latest stored observation per portal (not in the future).
     *
     * @return array<string, array{observedAt: string, temperature: ?float, precipitation: ?float, snowfall: ?float}>
     */
    public function latestPerPortal(): array
    {
        $out = [];
        $stmt = $this->pdo->prepare(
            'SELECT observed_at, temperature_c, precipitation_mm, snowfall_cm
               FROM gotthard_weather
              WHERE portal = :portal AND observed_at <= UTC_TIMESTAMP()
              ORDER BY observed_at DESC
              LIMIT 1'
        );
        foreach (['north', 'south'] as $portal) {
            $stmt->execute([':portal' => $portal]);
            $r = $stmt->fetch();
            if ($r) {
                $out[$portal] = [
                    'observedAt'    => (new DateTimeImmutable($r['observed_at'], new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM),
                    'temperature'   => $r['temperature_c'] !== null ? (float) $r['temperature_c'] : null,
                    'precipitation' => $r['precipitation_mm'] !== null ? (float) $r['precipitation_mm'] : null,
                    'snowfall'      => $r['snowfall_cm'] !== null ? (float) $r['snowfall_cm'] : null,
                ];
            }
        }
        return $out;
    }
}
