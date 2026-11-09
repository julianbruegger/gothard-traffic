<?php

declare(strict_types=1);

/**
 * Pure aggregate calculations over snapshot rows (no database access, so it is
 * unit-testable with plain arrays). Rows are oldest-first arrays with keys
 * fetched_at (UTC "Y-m-d H:i:s"), tunnel_status, closure_reason,
 * north_queue_km, north_wait_min, south_queue_km, south_wait_min.
 */
final class StatsCalculator
{
    /** Gaps longer than this (seconds) are "data gaps", not continuous coverage. */
    public const GAP_SECONDS = 1800;

    private DateTimeZone $utc;
    private DateTimeZone $zurich;

    public function __construct()
    {
        $this->utc    = new DateTimeZone('UTC');
        $this->zurich = new DateTimeZone('Europe/Zurich');
    }

    public function compute(array $rows, ?DateTimeImmutable $now = null): array
    {
        $now ??= new DateTimeImmutable('now', $this->utc);
        $pts = $this->prepare($rows);

        return [
            'generatedAt'  => $now->format(DateTimeInterface::ATOM),
            'heatmap'      => $this->heatmap($pts),
            'records'      => $this->records($pts),
            'asymmetry'    => $this->asymmetry($pts),
            'minutesPerKm' => $this->minutesPerKm($pts),
            'closures'     => $this->closures($pts),
            'jamDynamics'  => $this->jamDynamics($pts),
            'dataQuality'  => $this->dataQuality($pts),
            'last7d'       => $this->hourly($pts, $now, 7),
            'hourly30d'    => $this->hourly($pts, $now, 30),
        ];
    }

    /** @return list<array> normalised points with timestamp + local time parts */
    private function prepare(array $rows): array
    {
        $pts = [];
        foreach ($rows as $r) {
            $dt = new DateTimeImmutable($r['fetched_at'], $this->utc);
            $local = $dt->setTimezone($this->zurich);
            $pts[] = [
                'ts'     => $dt->getTimestamp(),
                'iso'    => $dt->format(DateTimeInterface::ATOM),
                'dow'    => (int) $local->format('N') - 1, // 0 = Monday
                'hour'   => (int) $local->format('G'),
                'day'    => $local->format('Y-m-d'),
                'month'  => $local->format('Y-m'),
                'status' => $r['tunnel_status'] ?? 'unknown',
                'reason' => $r['closure_reason'] ?? null,
                'nKm'    => (float) ($r['north_queue_km'] ?? 0),
                'nWait'  => (float) ($r['north_wait_min'] ?? 0),
                'sKm'    => (float) ($r['south_queue_km'] ?? 0),
                'sWait'  => (float) ($r['south_wait_min'] ?? 0),
            ];
        }
        return $pts;
    }

    private static function avg(float $sum, int $n): ?float
    {
        return $n > 0 ? round($sum / $n, 1) : null;
    }

    /** @return array{north: array, south: array} [portal][weekday 0-6][hour 0-23] => avg wait minutes */
    private function heatmap(array $pts): array
    {
        $out = [];
        foreach (['north' => 'nWait', 'south' => 'sWait'] as $portal => $key) {
            $grid = array_fill(0, 7, array_fill(0, 24, [0.0, 0]));
            foreach ($pts as $p) {
                $grid[$p['dow']][$p['hour']][0] += $p[$key];
                $grid[$p['dow']][$p['hour']][1]++;
            }
            $out[$portal] = array_map(
                fn (array $day) => array_map(fn (array $c) => self::avg($c[0], $c[1]), $day),
                $grid
            );
        }
        return $out;
    }

    private function records(array $pts): array
    {
        $maxQueue = null;
        $maxWait = null;
        $perDay = [];
        foreach ($pts as $p) {
            foreach ([['north', 'nKm', 'nWait'], ['south', 'sKm', 'sWait']] as [$portal, $km, $wait]) {
                if ($maxQueue === null || $p[$km] > $maxQueue['km']) {
                    $maxQueue = ['km' => $p[$km], 'portal' => $portal, 'at' => $p['iso']];
                }
                if ($maxWait === null || $p[$wait] > $maxWait['minutes']) {
                    $maxWait = ['minutes' => (int) $p[$wait], 'portal' => $portal, 'at' => $p['iso']];
                }
            }
            $perDay[$p['day']] = ($perDay[$p['day']] ?? 0.0) + $p['nWait'] + $p['sWait'];
        }
        $worstDay = null;
        foreach ($perDay as $day => $sum) {
            if ($worstDay === null || $sum > $worstDay['waitSum']) {
                $worstDay = ['date' => (string) $day, 'waitSum' => (int) round($sum)];
            }
        }

        // Longest stretch with no queue at either portal.
        $best = null;
        $runStart = null;
        $runEnd = null;
        $flush = function () use (&$best, &$runStart, &$runEnd): void {
            if ($runStart !== null && ($best === null || $runEnd - $runStart > $best['seconds'])) {
                $best = ['seconds' => $runEnd - $runStart, 'from' => $runStart, 'to' => $runEnd];
            }
            $runStart = null;
            $runEnd = null;
        };
        foreach ($pts as $p) {
            if ($p['nKm'] <= 0 && $p['sKm'] <= 0) {
                $runStart ??= $p['ts'];
                $runEnd = $p['ts'];
            } else {
                $flush();
            }
        }
        $flush();

        return [
            'longestQueue'   => $maxQueue,
            'longestWait'    => $maxWait,
            'worstDay'       => $worstDay,
            'longestJamFree' => $best === null ? null : [
                'hours' => round($best['seconds'] / 3600, 1),
                'from'  => gmdate(DateTimeInterface::ATOM, $best['from']),
                'to'    => gmdate(DateTimeInterface::ATOM, $best['to']),
            ],
        ];
    }

    private function asymmetry(array $pts): array
    {
        $m = [];
        foreach ($pts as $p) {
            $m[$p['month']] ??= [0.0, 0.0, 0];
            $m[$p['month']][0] += $p['nWait'];
            $m[$p['month']][1] += $p['sWait'];
            $m[$p['month']][2]++;
        }
        ksort($m);
        $out = [];
        foreach ($m as $month => [$n, $s, $c]) {
            $out[] = ['month' => (string) $month, 'north' => self::avg($n, $c), 'south' => self::avg($s, $c)];
        }
        return $out;
    }

    private function minutesPerKm(array $pts): array
    {
        $out = [];
        foreach (['north' => ['nKm', 'nWait'], 'south' => ['sKm', 'sWait']] as $portal => [$km, $wait]) {
            $sum = 0.0;
            $n = 0;
            foreach ($pts as $p) {
                if ($p[$km] > 0) {
                    $sum += $p[$wait] / $p[$km];
                    $n++;
                }
            }
            $out[$portal] = self::avg($sum, $n);
        }
        return $out;
    }

    private function closures(array $pts): array
    {
        $by = [];
        $prev = null;
        foreach ($pts as $p) {
            $closed = $p['status'] === 'closed';
            $wasClosed = $prev !== null && $prev['status'] === 'closed';
            $reason = $p['reason'] ?? 'unbekannt';
            if ($closed && !$wasClosed) {
                $by[$reason]['count'] = ($by[$reason]['count'] ?? 0) + 1;
            }
            if ($closed && $wasClosed) {
                $dt = min($p['ts'] - $prev['ts'], self::GAP_SECONDS);
                $by[$reason]['seconds'] = ($by[$reason]['seconds'] ?? 0) + $dt;
            }
            $prev = $p;
        }
        $out = [];
        foreach ($by as $reason => $v) {
            $out[] = [
                'reason' => (string) $reason,
                'count'  => $v['count'] ?? 0,
                'hours'  => round(($v['seconds'] ?? 0) / 3600, 1),
            ];
        }
        usort($out, fn ($a, $b) => $b['hours'] <=> $a['hours']);
        return $out;
    }

    private function jamDynamics(array $pts): array
    {
        $up = [0.0, 0];
        $down = [0.0, 0];
        for ($i = 1; $i < count($pts); $i++) {
            $dt = $pts[$i]['ts'] - $pts[$i - 1]['ts'];
            if ($dt <= 0 || $dt > self::GAP_SECONDS) {
                continue;
            }
            foreach (['nKm', 'sKm'] as $k) {
                $perHour = ($pts[$i][$k] - $pts[$i - 1][$k]) / ($dt / 3600);
                if ($perHour > 0) {
                    $up[0] += $perHour;
                    $up[1]++;
                } elseif ($perHour < 0) {
                    $down[0] += -$perHour;
                    $down[1]++;
                }
            }
        }
        return [
            'buildUpKmPerHour'  => self::avg($up[0], $up[1]),
            'dissolveKmPerHour' => self::avg($down[0], $down[1]),
        ];
    }

    private function dataQuality(array $pts): array
    {
        $gaps = 0;
        for ($i = 1; $i < count($pts); $i++) {
            if ($pts[$i]['ts'] - $pts[$i - 1]['ts'] > self::GAP_SECONDS) {
                $gaps++;
            }
        }
        return [
            'snapshots' => count($pts),
            'first'     => $pts ? $pts[0]['iso'] : null,
            'last'      => $pts ? $pts[count($pts) - 1]['iso'] : null,
            'gaps'      => $gaps,
        ];
    }

    /** Hourly average wait per portal for the last $days days (forecast vs reality, weather correlation). */
    private function hourly(array $pts, DateTimeImmutable $now, int $days): array
    {
        $from = $now->getTimestamp() - $days * 86400;
        $acc = [];
        foreach ($pts as $p) {
            if ($p['ts'] < $from) {
                continue;
            }
            $key = gmdate('Y-m-d\TH:00:00\Z', $p['ts']);
            $acc[$key] ??= [0.0, 0.0, 0];
            $acc[$key][0] += $p['nWait'];
            $acc[$key][1] += $p['sWait'];
            $acc[$key][2]++;
        }
        ksort($acc);
        $out = [];
        foreach ($acc as $hour => [$n, $s, $c]) {
            $out[] = ['t' => (string) $hour, 'north' => self::avg($n, $c), 'south' => self::avg($s, $c)];
        }
        return $out;
    }
}
