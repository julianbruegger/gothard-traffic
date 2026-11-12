<?php

declare(strict_types=1);

/**
 * Per-day hourly queue aggregate that the site's forecast model learns from.
 *
 * PHP port of site/scripts/build-observed-days.mjs: it condenses the raw
 * gotthard_snapshots rows (one reading every ~3 min) into the mean queue
 * length (km) per Swiss-local hour for every recorded day, after cleaning:
 *
 *  1. Stale reports: a <= 1 km reading that has not changed for more than
 *     STALE_AFTER_SEC is zeroed (ASTRA leaves such messages active overnight).
 *  2. Incident closures (anything but planned "Baustelle" roadworks) are
 *     excluded; their queues are real but random.
 *
 * Each reading is assigned to the NEAREST full hour (hour h covers
 * h-0:30 .. h+0:29), matching how forecast.ts samples its hourly profiles.
 */
final class ObservedDays
{
    private const STALE_AFTER_SEC = 120 * 60;
    private const STALE_MAX_KM    = 1.0;
    private const MIN_READINGS_PER_HOUR = 5;
    private const MIN_HOURS_PER_DAY     = 18;

    /**
     * @param array<int, array<string, mixed>> $rows Rows with fetched_at (UTC), tunnel_status,
     *                                               closure_reason, north_queue_km, south_queue_km.
     * @return array{meta: array<string, mixed>, days: array<int, array<string, mixed>>}
     */
    public static function build(array $rows): array
    {
        $utc = new DateTimeZone('UTC');
        $readings = [];
        foreach ($rows as $r) {
            $readings[] = [
                't'      => (new DateTimeImmutable((string) $r['fetched_at'], $utc))->getTimestamp(),
                'status' => $r['tunnel_status'] ?? null,
                'reason' => (string) ($r['closure_reason'] ?? ''),
                'N'      => (float) ($r['north_queue_km'] ?? 0),
                'S'      => (float) ($r['south_queue_km'] ?? 0),
            ];
        }
        usort($readings, static fn (array $a, array $b): int => $a['t'] <=> $b['t']);

        // Stale-report cleaning. Run detection must see the unzeroed values.
        $staleZeroed = 0;
        foreach (['N', 'S'] as $dir) {
            $orig = array_column($readings, $dir);
            $runStart = 0;
            foreach ($readings as $i => &$r) {
                if ($i > 0 && $orig[$i] !== $orig[$i - 1]) {
                    $runStart = $i;
                }
                if ($r[$dir] > 0 && $r[$dir] <= self::STALE_MAX_KM
                    && $r['t'] - $readings[$runStart]['t'] > self::STALE_AFTER_SEC) {
                    $r[$dir] = 0.0;
                    $staleZeroed++;
                }
            }
            unset($r);
        }

        $zurich = new DateTimeZone('Europe/Zurich');
        $cursor = new DateTime('@0');
        $cursor->setTimezone($zurich);

        $acc = [];
        $incidentExcluded = 0;
        foreach ($readings as $r) {
            $isIncident = $r['status'] === 'closed' && $r['reason'] !== '' && stripos($r['reason'], 'baustelle') === false;
            if ($isIncident) {
                $incidentExcluded++;
                continue;
            }
            $cursor->setTimestamp($r['t'] + 1800);
            [$day, $hour] = explode(' ', $cursor->format('Y-m-d G'));
            $hour = (int) $hour;
            if (!isset($acc[$day])) {
                $acc[$day] = ['N' => array_fill(0, 24, 0.0), 'S' => array_fill(0, 24, 0.0), 'n' => array_fill(0, 24, 0)];
            }
            $acc[$day]['N'][$hour] += $r['N'];
            $acc[$day]['S'][$hour] += $r['S'];
            $acc[$day]['n'][$hour]++;
        }
        ksort($acc);

        $days = [];
        foreach ($acc as $day => $v) {
            $hourly = static function (string $dir) use ($v): array {
                $out = [];
                foreach ($v['n'] as $h => $cnt) {
                    $out[] = $cnt >= self::MIN_READINGS_PER_HOUR ? round($v[$dir][$h] / $cnt, 2) : null;
                }
                return $out;
            };
            $n = $hourly('N');
            if (count(array_filter($n, static fn ($x): bool => $x !== null)) < self::MIN_HOURS_PER_DAY) {
                continue;
            }
            $days[] = ['d' => (string) $day, 'n' => $n, 's' => $hourly('S')];
        }

        $count = count($readings);
        return [
            'meta' => [
                'generatedAt'              => gmdate('c'),
                'source'                   => 'gotthard_snapshots (ASTRA DATEX II via opentransportdata.swiss), built live by api/observed.php',
                'firstReading'             => $count ? gmdate('c', $readings[0]['t']) : null,
                'lastReading'              => $count ? gmdate('c', $readings[$count - 1]['t']) : null,
                'readings'                 => $count,
                'staleReadingsZeroed'      => $staleZeroed,
                'incidentReadingsExcluded' => $incidentExcluded,
                'note'                     => 'Mean queue km per Swiss-local hour (nearest-hour buckets). n = Nordportal Göschenen (southbound), s = Südportal Airolo (northbound). null = too few readings.',
            ],
            'days' => $days,
        ];
    }
}
