<?php

declare(strict_types=1);

final class HistoryStore
{
    public function __construct(
        private readonly string $path,
        private readonly int $retentionHours,
        private readonly int $minIntervalMinutes,
    ) {
    }

    public function append(array $point): void
    {
        $history = JsonStore::read($this->path);
        if (!is_array($history)) {
            $history = [];
        }

        $last = end($history);
        if ($last !== false && isset($last['t'])) {
            $lastTime = strtotime((string) $last['t']);
            $nowTime = strtotime((string) $point['t']);
            if ($lastTime !== false && $nowTime !== false) {
                $minutesSinceLast = ($nowTime - $lastTime) / 60;
                if ($minutesSinceLast < $this->minIntervalMinutes) {
                    return;
                }
            }
        }

        $history[] = $point;

        $cutoff = time() - $this->retentionHours * 3600;
        $history = array_values(array_filter($history, static function ($p) use ($cutoff) {
            $t = strtotime((string) ($p['t'] ?? ''));
            return $t !== false && $t >= $cutoff;
        }));

        JsonStore::write($this->path, $history);
    }
}
