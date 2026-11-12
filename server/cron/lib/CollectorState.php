<?php

declare(strict_types=1);

/**
 * Tiny JSON state file for the collector: last success, consecutive failures,
 * last error, and whether a failure alert was already sent. Also rotates the
 * (otherwise ever-growing) error log.
 *
 * recordFailure() / recordSuccess() only report *whether* a mail should go out;
 * sending stays with the caller so this class has no side effects beyond the
 * state file.
 */
final class CollectorState
{
    private array $state;

    public function __construct(private readonly string $path)
    {
        $this->state = [
            'lastSuccess'         => null,
            'consecutiveFailures' => 0,
            'lastError'           => null,
            'alerted'             => false,
            'lastRetention'       => null,
        ];
        $raw = is_file($path) ? @file_get_contents($path) : false;
        $json = is_string($raw) ? json_decode($raw, true) : null;
        if (is_array($json)) {
            $this->state = array_merge($this->state, $json);
        }
    }

    public function get(string $key): mixed
    {
        return $this->state[$key] ?? null;
    }

    public function set(string $key, mixed $value): void
    {
        $this->state[$key] = $value;
    }

    /**
     * Mark a successful run.
     *
     * @return bool true when a "recovered" mail should be sent (an alert was out)
     */
    public function recordSuccess(string $isoNow): bool
    {
        $recovered = (bool) $this->state['alerted'];
        $this->state['lastSuccess'] = $isoNow;
        $this->state['consecutiveFailures'] = 0;
        $this->state['lastError'] = null;
        $this->state['alerted'] = false;
        $this->save();
        return $recovered;
    }

    /**
     * Mark a failed run.
     *
     * @return bool true exactly once per outage, when the failure threshold is
     *              first reached and an alert mail should be sent
     */
    public function recordFailure(string $message, int $threshold): bool
    {
        $this->state['consecutiveFailures'] = (int) $this->state['consecutiveFailures'] + 1;
        $this->state['lastError'] = mb_substr($message, 0, 500);
        $alert = false;
        if ($this->state['consecutiveFailures'] >= max(1, $threshold) && !$this->state['alerted']) {
            $this->state['alerted'] = true;
            $alert = true;
        }
        $this->save();
        return $alert;
    }

    public function save(): void
    {
        $dir = dirname($this->path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        @file_put_contents($this->path, json_encode($this->state, JSON_UNESCAPED_UNICODE), LOCK_EX);
    }

    /** Move $path to "$path.1" once it exceeds $maxBytes (one generation kept). */
    public static function rotateLog(string $path, int $maxBytes = 1048576): bool
    {
        if (!is_file($path) || (int) @filesize($path) <= $maxBytes) {
            return false;
        }
        @unlink($path . '.1');
        return @rename($path, $path . '.1');
    }
}
