<?php

declare(strict_types=1);

/**
 * CrawlerLog (bot matching, per-day counters, retention, never throwing) and
 * the endpoints that use it (api/crawlers.php, api/summary.php without a
 * database), run from a throw-away deploy dir like deploy.yml assembles it.
 *
 * Run: php server/cron/tests/test-crawler-log.php
 */

$root = dirname(__DIR__, 3);
require $root . '/server/lib/CrawlerLog.php';

$tmp = sys_get_temp_dir() . '/crawler-test-' . bin2hex(random_bytes(4));
mkdir($tmp, 0777, true);
$file = $tmp . '/hits.json';
$utc = new DateTimeZone('UTC');
$day1 = new DateTimeImmutable('2026-11-10T08:00:00Z');
$day2 = new DateTimeImmutable('2026-11-11T23:59:00Z');

$a = [];

// Matching: specific tokens win, ordinary browsers are ignored.
$a['GPTBot']             = CrawlerLog::match('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot') === 'GPTBot';
$a['OAI-SearchBot']      = CrawlerLog::match('Mozilla/5.0 ... compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot') === 'OAI-SearchBot';
$a['ChatGPT-User']       = CrawlerLog::match('Mozilla/5.0 ... compatible; ChatGPT-User/1.0; +https://openai.com/bot') === 'ChatGPT-User';
$a['ClaudeBot']          = CrawlerLog::match('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)') === 'ClaudeBot';
$a['Claude-User']        = CrawlerLog::match('Claude-User/1.0') === 'Claude-User';
$a['Claude-SearchBot']   = CrawlerLog::match('Claude-SearchBot/1.0') === 'Claude-SearchBot';
$a['PerplexityBot']      = CrawlerLog::match('Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)') === 'PerplexityBot';
$a['Perplexity-User']    = CrawlerLog::match('Mozilla/5.0 (compatible; Perplexity-User/1.0)') === 'Perplexity-User';
$a['Googlebot']          = CrawlerLog::match('Mozilla/5.0 (Linux; Android 6.0.1) Chrome/130 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)') === 'Googlebot';
$a['bingbot']            = CrawlerLog::match('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116 Safari/537.36') === 'bingbot';
$a['Applebot-Extended']  = CrawlerLog::match('Applebot-Extended/0.1') === 'Applebot-Extended';
$a['Applebot']           = CrawlerLog::match('Mozilla/5.0 (Macintosh) Version/17.4 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)') === 'Applebot';
$a['meta-externalagent'] = CrawlerLog::match('meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)') === 'meta-externalagent';
$a['DuckAssistBot']      = CrawlerLog::match('DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)') === 'DuckAssistBot';
$a['YandexBot']          = CrawlerLog::match('Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)') === 'YandexBot';
$a['CCBot']              = CrawlerLog::match('CCBot/2.0 (https://commoncrawl.org/faq/)') === 'CCBot';
$a['Bytespider']         = CrawlerLog::match('Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)') === 'Bytespider';
$a['browser ignored']    = CrawlerLog::match('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36') === null;
$a['empty ua ignored']   = CrawlerLog::match('') === null;

// Recording.
CrawlerLog::record('Mozilla/5.0 Chrome/131', '/', $file, $day1);
$a['browser writes nothing'] = !is_file($file);
CrawlerLog::record('GPTBot/1.2', '/?lang=en', $file, $day1);
CrawlerLog::record('GPTBot/1.2', '/', $file, $day1);
CrawlerLog::record('ClaudeBot/1.0', '/api/summary.php?lang=en', $file, $day1);
CrawlerLog::record('ClaudeBot/1.0', '/api/summary.php', $file, $day2);
$stored = json_decode((string) file_get_contents($file), true);
$a['per-day per-bot hits'] = ($stored['days']['2026-11-10']['GPTBot']['hits'] ?? null) === 2
    && ($stored['days']['2026-11-10']['ClaudeBot']['hits'] ?? null) === 1
    && ($stored['days']['2026-11-11']['ClaudeBot']['hits'] ?? null) === 1;
$a['query string stripped'] = ($stored['days']['2026-11-10']['GPTBot']['paths'] ?? null) === ['/' => 2];
$a['no ip / ua stored'] = !str_contains((string) file_get_contents($file), 'GPTBot/1.2');

// Path cap: at most 25 distinct paths per bot and day, then "(other)".
for ($i = 0; $i < 30; $i++) {
    CrawlerLog::record('YandexBot/3.0', "/p{$i}", $file, $day2);
}
$y = json_decode((string) file_get_contents($file), true)['days']['2026-11-11']['YandexBot'];
$a['path cap'] = $y['hits'] === 30 && count($y['paths']) === 26 && $y['paths']['(other)'] === 5;

// Retention: a record 60+ days later drops the old days.
CrawlerLog::record('bingbot/2.0', '/', $file, new DateTimeImmutable('2027-01-09T10:00:00Z'));
$days = array_keys(json_decode((string) file_get_contents($file), true)['days']);
$a['retention keeps 60 days'] = $days === ['2026-11-11', '2027-01-09'];

// Summary: last 30 days only, totals per bot.
$s = CrawlerLog::summary(30, $file, new DateTimeImmutable('2026-11-12T12:00:00Z'));
$a['summary window + totals'] = $s['days'] === 30 && array_keys($s['perDay']) === ['2026-11-11']
    && $s['totals'] === ['YandexBot' => 30, 'ClaudeBot' => 1];
$empty = json_encode(CrawlerLog::summary(30, $tmp . '/missing.json'));
$a['summary of missing file is empty objects'] = str_contains($empty, '"totals":{}') && str_contains($empty, '"perDay":{}');

// Never throws: unwritable target and corrupt file.
$threw = false;
try {
    CrawlerLog::record('GPTBot', '/', '/proc/definitely/not/writable.json', $day1);
    file_put_contents($tmp . '/corrupt.json', '{not json');
    CrawlerLog::record('GPTBot', '/', $tmp . '/corrupt.json', $day1);
} catch (Throwable) {
    $threw = true;
}
$a['never throws'] = !$threw;
$a['corrupt file recovered'] = (json_decode((string) file_get_contents($tmp . '/corrupt.json'), true)['days']['2026-11-10']['GPTBot']['hits'] ?? null) === 1;

// Endpoints, from a deploy-like dir (no cron/config.php -> no database).
$deploy = $tmp . '/web';
mkdir($deploy . '/lib', 0777, true);
mkdir($deploy . '/api', 0777, true);
foreach (glob($root . '/server/lib/*.php') as $f) {
    copy($f, $deploy . '/lib/' . basename($f));
}
foreach (glob($root . '/server/api/*.php') as $f) {
    copy($f, $deploy . '/api/' . basename($f));
}
copy($root . '/site/src/data/translations.json', $deploy . '/translations.json');

function run_api(string $script, array $get, string $ua): string
{
    $code = '$_GET = ' . var_export($get, true) . ';'
        . '$_SERVER["HTTP_USER_AGENT"] = ' . var_export($ua, true) . ';'
        . '$_SERVER["REQUEST_URI"] = "/api/' . basename($script) . '";'
        . 'require ' . var_export($script, true) . ';';
    return (string) shell_exec('php -d display_errors=1 -r ' . escapeshellarg($code) . ' 2>&1');
}

$sumDe = run_api($deploy . '/api/summary.php', [], 'Mozilla/5.0 (compatible; PerplexityBot/1.0)');
$sumEn = run_api($deploy . '/api/summary.php', ['lang' => 'en'], 'ChatGPT-User/1.0');
$sumXx = run_api($deploy . '/api/summary.php', ['lang' => ['x']], 'curl/8');
$a['summary.php de without db'] = str_starts_with($sumDe, 'Gotthard-Strassentunnel: Live-Verkehrsdaten sind derzeit nicht verfügbar')
    && str_contains($sumDe, 'Live-Seite: https://gotthard.jubr.app/');
$a['summary.php en without db'] = str_starts_with($sumEn, 'Gotthard road tunnel: live traffic data is currently not available')
    && str_contains($sumEn, 'Live page: https://gotthard.jubr.app/en');
$a['summary.php bad lang -> de'] = str_starts_with($sumXx, 'Gotthard-Strassentunnel:');
run_api($deploy . '/api/gotthard.php', [], 'GPTBot/1.2');
$crawlers = json_decode(run_api($deploy . '/api/crawlers.php', [], 'Mozilla/5.0'), true);
$a['crawlers.php counts endpoint hits'] = ($crawlers['totals']['PerplexityBot'] ?? null) === 1
    && ($crawlers['totals']['ChatGPT-User'] ?? null) === 1
    && ($crawlers['totals']['GPTBot'] ?? null) === 1
    && !isset($crawlers['totals']['curl']);

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
