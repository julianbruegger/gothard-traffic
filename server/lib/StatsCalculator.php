<?php

declare(strict_types=1);

/**
 * Aggregate calculations over snapshot rows (no database access, so it is
 * unit-testable with plain arrays). Rows are oldest-first arrays with keys
 * fetched_at (UTC "Y-m-d H:i:s"), tunnel_status, closure_reason,
 * north_queue_km, north_wait_min, south_queue_km, south_wait_min.
 *
 * Streaming use (constant memory apart from hour-level series):
 *
 *     $calc = new StatsCalculator();
 *     foreach ($store->iterateStatsRows(365) as $row) { $calc->add($row); }
 *     $stats = $calc->finish($now, $weather);
 *
 * Snapshots with status "closed" are excluded from every wait-time average
 * (the tunnel is shut, so "0 min" would dilute the figures); they still count
 * for closures, data quality and queue records.
 */
final class StatsCalculator
{
    /** Gaps longer than this (seconds) are "data gaps", not continuous coverage. */
    public const GAP_SECONDS = 1800;

    private const AFTER_CLOSURE_WINDOW = 3 * 3600;

    private DateTimeZone $utc;
    private DateTime $local;

    // ─── Running state ───────────────────────────────────────────────────────

    private int $count = 0;
    private ?string $firstIso = null;
    private ?string $lastIso = null;
    private int $gaps = 0;

    /** @var array{ts: int, status: string, reason: ?string, nKm: float, sKm: float}|null */
    private ?array $prev = null;

    /** @var array<string, array<int, array<int, array{0: float, 1: int}>>> portal => dow => hour => [sum, n] */
    private array $heat = [];
    /** @var array<string, array{0: float, 1: float, 2: int}> month => [northSum, southSum, n] */
    private array $months = [];
    /** @var array<string, array{0: float, 1: int}> */
    private array $perKm = [];
    /** @var array<string, array{0: float, 1: int}> */
    private array $weekday = [];
    /** @var array<string, array{0: float, 1: int}> */
    private array $weekend = [];
    /** @var array<string, array{0: float, 1: int}> */
    private array $overall = [];
    /** @var array<string, array{0: float, 1: int}> */
    private array $afterWin = [];
    private int $closureEnds = 0;
    private ?int $lastClosureEnd = null;

    /** @var array<int, array{0: float, 1: int, 2: float, 3: int}> UTC hour start => [nSum, nN, sSum, sN] (open snapshots only) */
    private array $hours = [];

    private ?array $maxQueue = null;
    private ?array $maxWait = null;
    /** @var array<string, float> */
    private array $perDay = [];
    private ?int $runStart = null;
    private ?int $runEnd = null;
    private ?array $bestRun = null;

    /** @var array<string, array{count: int, seconds: int}> */
    private array $closures = [];

    private array $up = [0.0, 0];
    private array $down = [0.0, 0];

    public function __construct()
    {
        $this->utc   = new DateTimeZone('UTC');
        $this->local = new DateTime('@0');
        $this->local->setTimezone(new DateTimeZone('Europe/Zurich'));
        $this->reset();
    }

    private function reset(): void
    {
        $this->count = 0;
        $this->firstIso = $this->lastIso = null;
        $this->gaps = 0;
        $this->prev = null;
        foreach (['north', 'south'] as $portal) {
            $this->heat[$portal] = array_fill(0, 7, array_fill(0, 24, [0.0, 0]));
            $this->perKm[$portal] = [0.0, 0];
            $this->weekday[$portal] = [0.0, 0];
            $this->weekend[$portal] = [0.0, 0];
            $this->overall[$portal] = [0.0, 0];
            $this->afterWin[$portal] = [0.0, 0];
        }
        $this->months = [];
        $this->closureEnds = 0;
        $this->lastClosureEnd = null;
        $this->hours = [];
        $this->maxQueue = $this->maxWait = null;
        $this->perDay = [];
        $this->runStart = $this->runEnd = null;
        $this->bestRun = null;
        $this->closures = [];
        $this->up = [0.0, 0];
        $this->down = [0.0, 0];
    }

    /** Convenience wrapper over add()/finish() for callers that already hold all rows. */
    public function compute(array $rows, ?DateTimeImmutable $now = null, array $weather = []): array
    {
        $this->reset();
        foreach ($rows as $r) {
            $this->add($r);
        }
        return $this->finish($now, $weather);
    }

    /** Stable key for a raw DATEX closure reason (language-independent). */
    public static function reasonKey(?string $reason): string
    {
        $r = strtolower(trim((string) $reason));
        if ($r === '') {
            return 'unknown';
        }
        $map = [
            'roadworks'         => ['baustelle', 'bauarbeiten', 'unterhalt', 'roadworks', 'maintenance'],
            'special_transport' => ['ausnahmetransport', 'sondertransport', 'special transport', 'abnormal'],
            'breakdown'         => ['panne', 'bergung', 'breakdown', 'fahrzeug'],
            'accident'          => ['unfall', 'accident', 'collision'],
            'fire'              => ['brand', 'feuer', 'fire'],
        ];
        foreach ($map as $key => $needles) {
            foreach ($needles as $n) {
                if (str_contains($r, $n)) {
                    return $key;
                }
            }
        }
        return 'unknown';
    }

    private static function avg(float $sum, int $n): ?float
    {
        return $n > 0 ? round($sum / $n, 1) : null;
    }

    /** Feed one snapshot row (oldest first). */
    public function add(array $r): void
    {
        $dt = new DateTimeImmutable($r['fetched_at'], $this->utc);
        $ts = $dt->getTimestamp();
        $this->local->setTimestamp($ts);
        $dow    = (int) $this->local->format('N') - 1; // 0 = Monday
        $hour   = (int) $this->local->format('G');
        $day    = $this->local->format('Y-m-d');
        $month  = $this->local->format('Y-m');
        $status = $r['tunnel_status'] ?? 'unknown';
        $reason = $r['closure_reason'] ?? null;
        $km     = ['north' => (float) ($r['north_queue_km'] ?? 0), 'south' => (float) ($r['south_queue_km'] ?? 0)];
        $wait   = ['north' => (float) ($r['north_wait_min'] ?? 0), 'south' => (float) ($r['south_wait_min'] ?? 0)];
        $iso    = $dt->format(DateTimeInterface::ATOM);
        $closed = $status === 'closed';
        $prev   = $this->prev;
        $wasClosed = $prev !== null && $prev['status'] === 'closed';

        // Data quality.
        $this->count++;
        $this->firstIso ??= $iso;
        $this->lastIso = $iso;
        if ($prev !== null && $ts - $prev['ts'] > self::GAP_SECONDS) {
            $this->gaps++;
        }

        // Records: queue/wait peaks and per-day sums.
        foreach (['north', 'south'] as $portal) {
            if ($this->maxQueue === null || $km[$portal] > $this->maxQueue['km']) {
                $this->maxQueue = ['km' => $km[$portal], 'portal' => $portal, 'at' => $iso];
            }
            if ($this->maxWait === null || $wait[$portal] > $this->maxWait['minutes']) {
                $this->maxWait = ['minutes' => (int) $wait[$portal], 'portal' => $portal, 'at' => $iso];
            }
        }
        $this->perDay[$day] = ($this->perDay[$day] ?? 0.0) + $wait['north'] + $wait['south'];

        // Longest stretch with no queue at either portal.
        if ($km['north'] <= 0 && $km['south'] <= 0) {
            $this->runStart ??= $ts;
            $this->runEnd = $ts;
        } else {
            $this->flushRun();
        }

        // Full closures: count at the start, book hours between consecutive closed snapshots.
        if ($closed) {
            $key = (string) ($reason ?? 'unbekannt');
            $this->closures[$key] ??= ['count' => 0, 'seconds' => 0];
            if (!$wasClosed) {
                $this->closures[$key]['count']++;
            } else {
                $this->closures[$key]['seconds'] += min($ts - $prev['ts'], self::GAP_SECONDS);
            }
        }
        if ($wasClosed && !$closed) {
            $this->closureEnds++;
            $this->lastClosureEnd = $ts;
        }

        // Jam dynamics (step based).
        if ($prev !== null) {
            $dtSec = $ts - $prev['ts'];
            if ($dtSec > 0 && $dtSec <= self::GAP_SECONDS) {
                foreach (['north' => 'nKm', 'south' => 'sKm'] as $portal => $k) {
                    $perHour = ($km[$portal] - $prev[$k]) / ($dtSec / 3600);
                    if ($perHour > 0) {
                        $this->up[0] += $perHour;
                        $this->up[1]++;
                    } elseif ($perHour < 0) {
                        $this->down[0] += -$perHour;
                        $this->down[1]++;
                    }
                }
            }
        }

        // Everything below is a wait-time average: closed snapshots do not count.
        if (!$closed) {
            $inWindow = $this->lastClosureEnd !== null && $ts < $this->lastClosureEnd + self::AFTER_CLOSURE_WINDOW;
            $isWeekend = $dow >= 5;

            $m = &$this->months[$month];
            $m ??= [0.0, 0.0, 0];
            $m[0] += $wait['north'];
            $m[1] += $wait['south'];
            $m[2]++;
            unset($m);

            foreach (['north', 'south'] as $portal) {
                $this->heat[$portal][$dow][$hour][0] += $wait[$portal];
                $this->heat[$portal][$dow][$hour][1]++;
                $this->overall[$portal][0] += $wait[$portal];
                $this->overall[$portal][1]++;
                if ($isWeekend) {
                    $this->weekend[$portal][0] += $wait[$portal];
                    $this->weekend[$portal][1]++;
                } else {
                    $this->weekday[$portal][0] += $wait[$portal];
                    $this->weekday[$portal][1]++;
                }
                if ($inWindow) {
                    $this->afterWin[$portal][0] += $wait[$portal];
                    $this->afterWin[$portal][1]++;
                }
                if ($km[$portal] > 0) {
                    $this->perKm[$portal][0] += $wait[$portal] / $km[$portal];
                    $this->perKm[$portal][1]++;
                }
            }

            $h = intdiv($ts, 3600) * 3600;
            $hr = &$this->hours[$h];
            $hr ??= [0.0, 0, 0.0, 0];
            $hr[0] += $wait['north'];
            $hr[1]++;
            $hr[2] += $wait['south'];
            $hr[3]++;
            unset($hr);
        }

        $this->prev = ['ts' => $ts, 'status' => $status, 'reason' => $reason, 'nKm' => $km['north'], 'sKm' => $km['south']];
    }

    private function flushRun(): void
    {
        if ($this->runStart !== null && ($this->bestRun === null || $this->runEnd - $this->runStart > $this->bestRun['seconds'])) {
            $this->bestRun = ['seconds' => $this->runEnd - $this->runStart, 'from' => $this->runStart, 'to' => $this->runEnd];
        }
        $this->runStart = null;
        $this->runEnd = null;
    }

    public function finish(?DateTimeImmutable $now = null, array $weather = []): array
    {
        $now ??= new DateTimeImmutable('now', $this->utc);
        $this->flushRun();
        ksort($this->hours);

        return [
            'generatedAt'  => $now->format(DateTimeInterface::ATOM),
            'heatmap'      => $this->heatmapOut(),
            'records'      => $this->recordsOut(),
            'asymmetry'    => $this->asymmetryOut(),
            'minutesPerKm' => ['north' => self::avg(...$this->perKm['north']), 'south' => self::avg(...$this->perKm['south'])],
            'closures'     => $this->closuresOut(),
            'jamDynamics'  => [
                'buildUpKmPerHour'  => self::avg(...$this->up),
                'dissolveKmPerHour' => self::avg(...$this->down),
            ],
            'dataQuality'  => ['snapshots' => $this->count, 'first' => $this->firstIso, 'last' => $this->lastIso, 'gaps' => $this->gaps],
            'last7d'       => $this->hourlyOut($now, 7),
            'hourly30d'    => $this->hourlyOut($now, 30),
            'correlations' => $this->correlationsOut($weather),
        ];
    }

    private function heatmapOut(): array
    {
        $out = [];
        foreach ($this->heat as $portal => $grid) {
            $out[$portal] = array_map(
                fn (array $day) => array_map(fn (array $c) => self::avg($c[0], $c[1]), $day),
                $grid
            );
        }
        return $out;
    }

    private function recordsOut(): array
    {
        $worstDay = null;
        foreach ($this->perDay as $day => $sum) {
            if ($worstDay === null || $sum > $worstDay['waitSum']) {
                $worstDay = ['date' => (string) $day, 'waitSum' => (int) round($sum)];
            }
        }
        $best = $this->bestRun;
        return [
            'longestQueue'   => $this->maxQueue,
            'longestWait'    => $this->maxWait,
            'worstDay'       => $worstDay,
            'longestJamFree' => $best === null ? null : [
                'hours' => round($best['seconds'] / 3600, 1),
                'from'  => gmdate(DateTimeInterface::ATOM, $best['from']),
                'to'    => gmdate(DateTimeInterface::ATOM, $best['to']),
            ],
        ];
    }

    private function asymmetryOut(): array
    {
        $m = $this->months;
        ksort($m);
        $out = [];
        foreach ($m as $month => [$n, $s, $c]) {
            $out[] = ['month' => (string) $month, 'north' => self::avg($n, $c), 'south' => self::avg($s, $c)];
        }
        return $out;
    }

    private function closuresOut(): array
    {
        $out = [];
        foreach ($this->closures as $reason => $v) {
            $out[] = [
                'reason' => (string) $reason,
                'key'    => self::reasonKey((string) $reason),
                'count'  => $v['count'],
                'hours'  => round($v['seconds'] / 3600, 1),
            ];
        }
        usort($out, fn ($a, $b) => $b['hours'] <=> $a['hours']);
        return $out;
    }

    /** Hourly average wait per portal for the last $days days (forecast vs reality). */
    private function hourlyOut(DateTimeImmutable $now, int $days): array
    {
        $from = $now->getTimestamp() - $days * 86400;
        $out = [];
        foreach ($this->hours as $h => [$ns, $nn, $ss, $sn]) {
            if ($h + 3600 <= $from) {
                continue;
            }
            $out[] = ['t' => gmdate('Y-m-d\TH:00:00\Z', $h), 'north' => self::avg($ns, $nn), 'south' => self::avg($ss, $sn)];
        }
        return $out;
    }

    // ─── Correlations ────────────────────────────────────────────────────────

    private function correlationsOut(array $weather): array
    {
        $north = [];
        $south = [];
        foreach ($this->hours as $h => [$ns, $nn, $ss, $sn]) {
            $north[$h] = $ns / $nn;
            $south[$h] = $ss / $sn;
        }

        $weekend = [];
        $after = [];
        foreach (['north', 'south'] as $portal) {
            $w = self::avg(...$this->weekday[$portal]);
            $e = self::avg(...$this->weekend[$portal]);
            $weekend[$portal] = [
                'weekday' => $w,
                'weekend' => $e,
                'ratio'   => ($w !== null && $w > 0 && $e !== null) ? round($e / $w, 2) : null,
            ];
            $a = self::avg(...$this->afterWin[$portal]);
            $o = self::avg(...$this->overall[$portal]);
            $after[$portal] = [
                'afterAvg'   => $a,
                'overallAvg' => $o,
                'ratio'      => ($a !== null && $o !== null && $o > 0) ? round($a / $o, 2) : null,
            ];
        }

        return [
            'northSouth'   => $this->northSouth($north, $south),
            'weather'      => $this->weatherCorrelations($north, $south, $weather),
            'weekend'      => $weekend,
            'afterClosure' => ['events' => $this->closureEnds] + $after,
        ];
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

}
