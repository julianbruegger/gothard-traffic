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

        $plannedClosures = $tunnel['plannedClosures'] ?? [];

        $params = [
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
        ];

        // pass_source is a newer, nullable column. Installs that have not run
        // the ALTER from schema.sql yet keep working without it.
        $sql = 'INSERT INTO gotthard_snapshots
               (fetched_at,
                tunnel_status, closure_reason,
                north_queue_km, north_wait_min, north_cause,
                south_queue_km, south_wait_min, south_cause,
                pass_status, pass_note, planned_closures%COL%)
             VALUES
               (:fetched_at,
                :tunnel_status, :closure_reason,
                :north_queue_km, :north_wait_min, :north_cause,
                :south_queue_km, :south_wait_min, :south_cause,
                :pass_status, :pass_note, :planned_closures%VAL%)';
        try {
            $stmt = $this->pdo->prepare(str_replace(['%COL%', '%VAL%'], [', pass_source', ', :pass_source'], $sql));
            $stmt->execute($params + [':pass_source' => $pass['source'] ?? null]);
        } catch (PDOException $e) {
            if (stripos($e->getMessage(), 'pass_source') === false) {
                throw $e;
            }
            $stmt = $this->pdo->prepare(str_replace(['%COL%', '%VAL%'], '', $sql));
            $stmt->execute($params);
        }
    }

    /**
     * Retention: thin rows older than $days days to one per hour (the first of
     * each hour is kept). Returns the number of deleted rows.
     */
    public function thinOlderThan(int $days): int
    {
        $cutoff = gmdate('Y-m-d H:i:s', time() - $days * 86400);
        $stmt = $this->pdo->prepare(
            "DELETE FROM gotthard_snapshots
              WHERE fetched_at < :cutoff1
                AND id NOT IN (
                    SELECT keep_id FROM (
                        SELECT MIN(id) AS keep_id
                          FROM gotthard_snapshots
                         WHERE fetched_at < :cutoff2
                         GROUP BY DATE_FORMAT(fetched_at, '%Y-%m-%d %H')
                    ) kept
                )"
        );
        $stmt->execute([':cutoff1' => $cutoff, ':cutoff2' => $cutoff]);
        return $stmt->rowCount();
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
                    tunnel_status,
                    north_queue_km, north_wait_min,
                    south_queue_km, south_wait_min
               FROM gotthard_snapshots
              WHERE fetched_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :hours HOUR)
              ORDER BY fetched_at ASC'
        );
        $stmt->execute([':hours' => $hours]);
        return $stmt->fetchAll();
    }

    /**
     * Rows for the Nerd Mode statistics: the last $days days, oldest first.
     * Filters on fetched_at so the index is used.
     */
    public function statsRows(int $days = 365): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT fetched_at, tunnel_status, closure_reason,
                    north_queue_km, north_wait_min,
                    south_queue_km, south_wait_min
               FROM gotthard_snapshots
              WHERE fetched_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL :days DAY)
              ORDER BY fetched_at ASC'
        );
        $stmt->bindValue(':days', $days, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }
}
