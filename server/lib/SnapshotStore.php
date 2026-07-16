<?php

declare(strict_types=1);

require_once __DIR__ . '/Db.php';

/**
 * Reads and writes traffic snapshots to the gotthard_snapshots table.
 * All timestamps are stored and returned in UTC.
 */
final class SnapshotStore
{
    public function __construct(private readonly PDO $pdo)
    {
    }

    /**
     * Insert one snapshot row.
     *
     * @param array  $result     Parsed result from TrafficParser::parse()
     * @param string $fetchedAt  ISO 8601 UTC timestamp string
     */
    public function insert(array $result, string $fetchedAt): void
    {
        $tunnel = $result['tunnel'];
        $pass   = $result['pass'];

        $stmt = $this->pdo->prepare(
            'INSERT INTO gotthard_snapshots
               (fetched_at,
                tunnel_status, closure_reason,
                north_queue_km, north_wait_min, north_cause,
                south_queue_km, south_wait_min, south_cause,
                pass_status, pass_note, planned_closures)
             VALUES
               (:fetched_at,
                :tunnel_status, :closure_reason,
                :north_queue_km, :north_wait_min, :north_cause,
                :south_queue_km, :south_wait_min, :south_cause,
                :pass_status, :pass_note, :planned_closures)'
        );

        $plannedClosures = $tunnel['plannedClosures'] ?? [];

        $stmt->execute([
            ':fetched_at'     => gmdate('Y-m-d H:i:s', strtotime($fetchedAt)),
            ':tunnel_status'  => $tunnel['status'],
            ':closure_reason' => $tunnel['closureReason'] ?? null,
            ':north_queue_km' => $tunnel['north']['queueKm'],
            ':north_wait_min' => $tunnel['north']['waitMinutes'],
            ':north_cause'    => $tunnel['north']['cause'] ?? null,
            ':south_queue_km' => $tunnel['south']['queueKm'],
            ':south_wait_min' => $tunnel['south']['waitMinutes'],
            ':south_cause'    => $tunnel['south']['cause'] ?? null,
            ':pass_status'    => $pass['status'],
            ':pass_note'      => $pass['note'] ?? null,
            ':planned_closures' => $plannedClosures
                ? json_encode($plannedClosures, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                : null,
        ]);
    }

    /**
     * Return the most recent snapshot row, or null if the table is empty.
     */
    public function latest(): ?array
    {
        $row = $this->pdo
            ->query('SELECT * FROM gotthard_snapshots ORDER BY fetched_at DESC LIMIT 1')
            ->fetch();

        return ($row !== false) ? $row : null;
    }

    /**
     * Return all snapshots within the last $hours hours, oldest first.
     * Used to build the Verlauf (history) chart.
     */
    public function history(int $hours = 48): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT fetched_at,
                    north_queue_km, north_wait_min,
                    south_queue_km, south_wait_min
               FROM gotthard_snapshots
              WHERE fetched_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :hours HOUR)
              ORDER BY fetched_at ASC'
        );
        $stmt->execute([':hours' => $hours]);
        return $stmt->fetchAll();
    }
}
