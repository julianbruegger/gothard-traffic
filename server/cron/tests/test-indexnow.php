<?php

declare(strict_types=1);

/**
 * IndexNow change detection, rate limit, payload and key file - no network
 * (the HTTP sender is injected).
 *
 * Run: php server/cron/tests/test-indexnow.php
 */

require __DIR__ . '/../lib/IndexNow.php';

$tmp = sys_get_temp_dir() . '/indexnow-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0777, true);
$statePath = $tmp . '/data/indexnow-state.json';
$key = 'a1b2c3d4-e5f6-4711-8888-0123456789ab';

$calls = [];
$httpCode = 200;
$sender = function (string $url, string $body) use (&$calls, &$httpCode): int {
    $calls[] = ['url' => $url, 'body' => json_decode($body, true)];
    return $httpCode;
};

function snap(string $status, array $closures = []): array
{
    return ['tunnel' => ['status' => $status, 'plannedClosures' => $closures]];
}

$n = new IndexNow($key, 'https://gotthard.jubr.app/', $statePath, $sender);
$t0 = 1_800_000_000;
$a = [];

// Key format.
$a['valid key']            = IndexNow::isValidKey($key);
$a['short key invalid']    = !IndexNow::isValidKey('abc');
$a['path chars invalid']   = !IndexNow::isValidKey('../../index.php');
$a['too long invalid']     = !IndexNow::isValidKey(str_repeat('a', 129));
$bad = new IndexNow('bad/key', 'https://gotthard.jubr.app', $statePath, $sender);
$a['invalid key: no ping, no file'] = $bad->maybePing(snap('closed'), snap('open'), $t0) === 'invalid-key'
    && $bad->ensureKeyFile($tmp) === false && $calls === [];

// Signature: offsets and order do not matter, cause does.
$c1 = ['from' => '2026-11-11T22:00:00+00:00', 'to' => '2026-11-12T00:00:00+00:00', 'cause' => 'Unterhalt'];
$c1z = ['from' => '2026-11-11T23:00:00+01:00', 'to' => '2026-11-12T01:00:00+01:00', 'cause' => 'Unterhalt'];
$c2 = ['from' => '2026-11-13T22:00:00+00:00', 'to' => null, 'cause' => 'Sondertransport'];
$a['signature: offset-insensitive'] = IndexNow::signature(snap('open', [$c1])) === IndexNow::signature(snap('open', [$c1z]));
$a['signature: order-insensitive']  = IndexNow::signature(snap('open', [$c1, $c2])) === IndexNow::signature(snap('open', [$c2, $c1]));
$a['signature: open vs congested']  = IndexNow::signature(snap('open')) !== IndexNow::signature(snap('congested'));
$a['signature: cause matters']      = IndexNow::signature(snap('open', [$c1])) !== IndexNow::signature(snap('open', [array_merge($c1, ['cause' => 'Unfall'])]));
$a['signature: null']               = IndexNow::signature(null) === null;

// First run, no previous snapshot: remember, no ping.
$a['first run without baseline'] = $n->maybePing(snap('open'), null, $t0) === 'unchanged' && $calls === [];
// Same state: nothing.
$a['unchanged'] = $n->maybePing(snap('open'), snap('open'), $t0 + 180) === 'unchanged' && $calls === [];
// open -> congested: ping.
$a['open->congested pings'] = $n->maybePing(snap('congested'), snap('open'), $t0 + 360) === 'pinged' && count($calls) === 1;
$body = $calls[0]['body'] ?? [];
$a['payload'] = ($calls[0]['url'] ?? '') === 'https://api.indexnow.org/indexnow'
    && $body['host'] === 'gotthard.jubr.app'
    && $body['key'] === $key
    && $body['keyLocation'] === "https://gotthard.jubr.app/{$key}.txt"
    && $body['urlList'] === [
        'https://gotthard.jubr.app/',
        'https://gotthard.jubr.app/en',
        'https://gotthard.jubr.app/sperrungen',
        'https://gotthard.jubr.app/en/closures',
    ];
// New closure 10 min later: rate-limited, stays pending ...
$a['change within 30 min rate-limited'] = $n->maybePing(snap('congested', [$c1]), snap('congested'), $t0 + 960) === 'rate-limited' && count($calls) === 1;
$a['still pending'] = $n->maybePing(snap('congested', [$c1]), snap('congested', [$c1]), $t0 + 1200) === 'rate-limited' && count($calls) === 1;
// ... and is sent once the window has passed, even though the previous snapshot already matches.
$a['pending change sent after window'] = $n->maybePing(snap('congested', [$c1]), snap('congested', [$c1]), $t0 + 360 + 1800) === 'pinged' && count($calls) === 2;
$a['then unchanged'] = $n->maybePing(snap('congested', [$c1]), snap('congested', [$c1]), $t0 + 4000) === 'unchanged' && count($calls) === 2;

// Failure: counted for the rate limit, change stays pending, never throws.
$httpCode = 500;
$a['failed ping reported'] = $n->maybePing(snap('closed', [$c1]), snap('congested', [$c1]), $t0 + 6000) === 'failed' && count($calls) === 3;
$httpCode = 200;
$a['no retry within window'] = $n->maybePing(snap('closed', [$c1]), snap('closed', [$c1]), $t0 + 6200) === 'rate-limited' && count($calls) === 3;
$a['retried after window'] = $n->maybePing(snap('closed', [$c1]), snap('closed', [$c1]), $t0 + 6000 + 1800) === 'pinged' && count($calls) === 4;
$throwing = new IndexNow($key, 'https://gotthard.jubr.app', $tmp . '/other-state.json', function (): int {
    throw new RuntimeException('network down');
});
$a['throwing sender -> failed'] = $throwing->maybePing(snap('closed'), snap('open'), $t0) === 'failed';

// First run with a previous snapshot as baseline: a change pings right away.
$fresh = new IndexNow($key, 'https://gotthard.jubr.app', $tmp . '/fresh-state.json', $sender);
$a['baseline from previous snapshot'] = $fresh->maybePing(snap('closed'), snap('open'), $t0) === 'pinged' && count($calls) === 5;

// State file persisted.
$state = json_decode((string) file_get_contents($statePath), true);
$a['state persisted'] = ($state['lastPing'] ?? null) === $t0 + 7800 && ($state['lastStatus'] ?? null) === 200;

// Key file.
$a['key file written'] = $n->ensureKeyFile($tmp) && file_get_contents("{$tmp}/{$key}.txt") === $key;
file_put_contents("{$tmp}/{$key}.txt", 'stale');
$a['key file repaired'] = $n->ensureKeyFile($tmp . '/') && file_get_contents("{$tmp}/{$key}.txt") === $key;

// cleanup
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $f) {
    $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
}
@rmdir($tmp);

$failures = 0;
foreach ($a as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}
exit($failures > 0 ? 1 : 0);
