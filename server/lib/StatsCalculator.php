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

    public function compute(array $rows, ?DateTimeImmutable $now = null, array $weather = []): array
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
            'correlations' => $this->correlations($pts, $weather),
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

    // ─── Correlations ────────────────────────────────────────────────────────

    /**
     * @param list<array> $pts      prepared snapshot points
     * @param list<array> $weather  rows of gotthard_weather (observed_at, portal,
     *                              temperature_c, precipitation_mm, snowfall_cm)
     */
    private function correlations(array $pts, array $weather): array
    {
        $north = $this->hourlySeries($pts, 'nWait');
        $south = $this->hourlySeries($pts, 'sWait');

        return [
            'northSouth'   => $this->northSouth($north, $south),
            'weather'      => $this->weatherCorrelations($north, $south, $weather),
            'weekend'      => $this->weekendEffect($pts),
            'afterClosure' => $this->afterClosure($pts),
        ];
    }

    /** @return array<int, float> UTC hour start (unix ts) => mean wait in that hour */
    private function hourlySeries(array $pts, string $key): array
    {
        $acc = [];
        foreach ($pts as $p) {
            $h = intdiv($p['ts'], 3600) * 3600;
            $acc[$h] ??= [0.0, 0];
            $acc[$h][0] += $p[$key];
            $acc[$h][1]++;
        }
        return array_map(static fn (array $a): float => $a[0] / $a[1], $acc);
    }

    /**
     * Pearson r after removing each UTC hour-of-day's mean from both series, so
     * the shared daily rhythm does not masquerade as a relationship.
     *
     * @param list<array{0: int, 1: float, 2: float}> $triples [hourOfDay, x, y]
     */
    public static function deseasonedPearson(array $triples): ?float
    {
        if (count($triples) < 24) {
            return null;
        }
        $by = [];
        foreach ($triples as [$h, $x, $y]) {
            $by[$h][0][] = $x;
            $by[$h][1][] = $y;
        }
        $means = [];
        foreach ($by as $h => [$xs, $ys]) {
            $means[$h] = [array_sum($xs) / count($xs), array_sum($ys) / count($ys)];
        }
        $sxy = $sxx = $syy = 0.0;
        foreach ($triples as [$h, $x, $y]) {
            $dx = $x - $means[$h][0];
            $dy = $y - $means[$h][1];
            $sxy += $dx * $dy;
            $sxx += $dx * $dx;
            $syy += $dy * $dy;
        }
        if (!($sxx > 0 && $syy > 0)) {
            return null;
        }
        $r = round($sxy / sqrt($sxx * $syy), 2);
        return $r == 0.0 ? 0.0 : $r; // avoid "-0"
    }

    /** Do jams on both sides coincide, and does one lead the other? */
    private function northSouth(array $north, array $south): array
    {
        $r = [];
        for ($lag = -6; $lag <= 6; $lag++) { // south at t+lag vs north at t
            $triples = [];
            foreach ($north as $t => $n) {
                $s = $south[$t + $lag * 3600] ?? null;
                if ($s !== null) {
                    $triples[] = [intdiv($t, 3600) % 24, $n, $s];
                }
            }
            $r[$lag] = self::deseasonedPearson($triples);
        }
        $best = null;
        foreach ($r as $lag => $v) {
            if ($v !== null && ($best === null || abs($v) > abs($best['r']))) {
                $best = ['lagHours' => $lag, 'r' => $v];
            }
        }
        return ['sameHour' => $r[0] ?? null, 'best' => $best];
    }

    private function weatherCorrelations(array $north, array $south, array $weather): array
    {
        $byPortal = ['north' => [], 'south' => []];
        foreach ($weather as $w) {
            $t = (new DateTimeImmutable($w['observed_at'], $this->utc))->getTimestamp();
            $byPortal[$w['portal']][$t] = [
                'temperature'   => $w['temperature_c'] !== null ? (float) $w['temperature_c'] : null,
                'precipitation' => $w['precipitation_mm'] !== null ? (float) $w['precipitation_mm'] : null,
                'snowfall'      => $w['snowfall_cm'] !== null ? (float) $w['snowfall_cm'] : null,
            ];
        }

        $out = [];
        foreach (['north' => $north, 'south' => $south] as $portal => $wait) {
            $row = ['portal' => $portal, 'hours' => 0, 'r' => [], 'wetAvg' => null, 'dryAvg' => null, 'wetHours' => 0];
            $wet = [0.0, 0];
            $dry = [0.0, 0];
            foreach (['temperature', 'precipitation', 'snowfall'] as $var) {
                $triples = [];
                foreach ($wait as $t => $w) {
                    $x = $byPortal[$portal][$t][$var] ?? null;
                    if ($x !== null) {
                        $triples[] = [intdiv($t, 3600) % 24, $x, $w];
                    }
                }
                $row['r'][$var] = self::deseasonedPearson($triples);
                $row['hours'] = max($row['hours'], count($triples));
            }
            foreach ($wait as $t => $w) {
                $p = $byPortal[$portal][$t]['precipitation'] ?? null;
                if ($p === null) {
                    continue;
                }
                if ($p > 0.1) {
                    $wet[0] += $w;
                    $wet[1]++;
                } else {
                    $dry[0] += $w;
                    $dry[1]++;
                }
            }
            $row['wetAvg']   = self::avg($wet[0], $wet[1]);
            $row['dryAvg']   = self::avg($dry[0], $dry[1]);
            $row['wetHours'] = $wet[1];
            $out[] = $row;
        }
        return $out;
    }

    /** Average wait on weekdays vs weekends (Swiss local days), per portal. */
    private function weekendEffect(array $pts): array
    {
        $out = [];
        foreach (['north' => 'nWait', 'south' => 'sWait'] as $portal => $key) {
            $wk = [0.0, 0];
            $we = [0.0, 0];
            foreach ($pts as $p) {
                if ($p['dow'] >= 5) {
                    $we[0] += $p[$key];
                    $we[1]++;
                } else {
                    $wk[0] += $p[$key];
                    $wk[1]++;
                }
            }
            $w = self::avg($wk[0], $wk[1]);
            $e = self::avg($we[0], $we[1]);
            $out[$portal] = [
                'weekday' => $w,
                'weekend' => $e,
                'ratio'   => ($w !== null && $w > 0 && $e !== null) ? round($e / $w, 2) : null,
            ];
        }
        return $out;
    }

    /** Average wait in the 3 hours after a full closure ends, vs the overall average. */
    private function afterClosure(array $pts): array
    {
        $window = 3 * 3600;
        $ends = [];
        for ($i = 1; $i < count($pts); $i++) {
            if ($pts[$i - 1]['status'] === 'closed' && $pts[$i]['status'] !== 'closed') {
                $ends[] = $pts[$i]['ts'];
            }
        }
        $out = ['events' => count($ends)];
        foreach (['north' => 'nWait', 'south' => 'sWait'] as $portal => $key) {
            $all = [0.0, 0];
            $after = [0.0, 0];
            foreach ($pts as $p) {
                $all[0] += $p[$key];
                $all[1]++;
                foreach ($ends as $e) {
                    if ($p['ts'] >= $e && $p['ts'] < $e + $window) {
                        $after[0] += $p[$key];
                        $after[1]++;
                        break;
                    }
                }
            }
            $a = self::avg($after[0], $after[1]);
            $o = self::avg($all[0], $all[1]);
            $out[$portal] = [
                'afterAvg' => $a,
                'overallAvg' => $o,
                'ratio' => ($a !== null && $o !== null && $o > 0) ? round($a / $o, 2) : null,
            ];
        }
        return $out;
    }
}
