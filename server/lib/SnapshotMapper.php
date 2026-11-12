<?php

declare(strict_types=1);

/** Maps a gotthard_snapshots DB row to the public JSON/SSR data shape (shared by api/gotthard.php and index.php). */
final class SnapshotMapper
{
    public static function fromRow(array $row): array
    {
        $updatedAt = (new DateTimeImmutable($row['fetched_at'], new DateTimeZone('UTC')))->format(DateTimeInterface::ATOM);

        $planned = [];
        if (isset($row['planned_closures']) && $row['planned_closures'] !== null) {
            $decoded = json_decode((string) $row['planned_closures'], true);
            $planned = is_array($decoded) ? $decoded : [];
        }

        return [
            'updated' => $updatedAt,
            'source'  => 'opentransportdata.swiss (ASTRA Traffic Situations)',
            'tunnel'  => [
                'status' => $row['tunnel_status'],
                'closureReason' => $row['closure_reason'] ?? null,
                'north'  => [
                    'queueKm'     => $row['north_queue_km'] !== null ? (float) $row['north_queue_km'] : null,
                    'waitMinutes' => $row['north_wait_min'] !== null ? (int)   $row['north_wait_min'] : null,
                    'cause'       => $row['north_cause'],
                    'closures'    => [],
                ],
                'south'  => [
                    'queueKm'     => $row['south_queue_km'] !== null ? (float) $row['south_queue_km'] : null,
                    'waitMinutes' => $row['south_wait_min'] !== null ? (int)   $row['south_wait_min'] : null,
                    'cause'       => $row['south_cause'],
                    'closures'    => [],
                ],
                'plannedClosures' => $planned,
            ],
            'pass' => [
                'status' => $row['pass_status'],
                'note'   => $row['pass_note'],
                'source' => $row['pass_source'] ?? null,
            ],
        ];
    }
}
