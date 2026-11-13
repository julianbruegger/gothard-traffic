<?php

declare(strict_types=1);

/**
 * End-to-end test of index.php as the front controller for every page.
 * Assembles a throw-away web root (index.php, lib/, translations.json, fixture
 * pages, forecast-days.json, a CrawlerLog stub; no cron/config.php -> default
 * data, no DB) and serves it with PHP's built-in server. The router below
 * emulates the .htaccess page rewrite ("/x" -> index.php?page=x) but none of
 * its redirects, so index.php's own defensive redirects are exercised.
 *
 * Run: php server/cron/tests/test-routing.php
 */

$root = dirname(__DIR__, 3);
$tmp  = sys_get_temp_dir() . '/routing-test-' . bin2hex(random_bytes(4));
mkdir($tmp . '/lib', 0777, true);
mkdir($tmp . '/en', 0777, true);
mkdir($tmp . '/cron', 0777, true);
copy($root . '/server/index.php', $tmp . '/index.php');
foreach (glob($root . '/server/lib/*.php') as $f) {
    copy($f, $tmp . '/lib/' . basename($f));
}
copy($root . '/site/src/data/translations.json', $tmp . '/translations.json');
file_put_contents($tmp . '/cron/secret.html', '<html lang="de"><body>SECRET</body></html>');

// CrawlerLog stub (the real one is maintained separately) records its calls.
file_put_contents($tmp . '/lib/CrawlerLog.php', '<?php final class CrawlerLog { public static function record(string $ua, string $path): void {'
    . ' file_put_contents(__DIR__ . "/../crawler.log", $ua . "|" . $path . "\n", FILE_APPEND); } }');

$home = static fn (string $lang, string $marker): string => <<<HTML
<!doctype html><html lang="{$lang}" data-lang="{$lang}"><head><title>old</title><meta name="description" content="old">
<link rel="canonical" href="https://stale.example/old"><script type="application/ld+json" id="ld-traffic">{}</script></head><body>
{$marker}<span id="status-label"><!--SSR:status-label-->STALE<!--/SSR--></span><p id="summary"><!--SSR:summary-->STALE SUMMARY<!--/SSR--></p>
<time id="hero-updated" datetime><!--SSR:updated-human-->14.07.2026, 19:07<!--/SSR--></time>
<div id="forecast-week"><!--SSR:forecast-week-->BUILD DAY<!--/SSR--></div></body></html>
HTML;
$page = static fn (string $lang, string $title, string $canonical, string $marker): string => <<<HTML
<!doctype html><html lang="{$lang}" data-lang="{$lang}"><head><title>{$title}</title><meta name="description" content="Own description">
<link rel="canonical" href="{$canonical}"></head><body>{$marker}
<span id="status-badge" data-status="unknown"><span id="status-label"><!--SSR:status-label-->STALE<!--/SSR--></span></span>
<div id="forecast-week"><!--SSR:forecast-week-->BUILD DAY<!--/SSR--></div>
<div><!--SSR:forecast-range:2000-01-01:2000-01-02-->BUILD RANGE<!--/SSR--></div></body></html>
HTML;
$plain = '<!doctype html><html lang="de" data-lang="de"><head><title>Plain</title></head><body>PLAIN <b>static</b></body></html>';

file_put_contents($tmp . '/index.html', $home('de', 'TEMPLATE-DE'));
file_put_contents($tmp . '/en.html', $home('en', 'TEMPLATE-EN'));
file_put_contents($tmp . '/forecasts.html', $page('de', 'Gotthard Stau Prognose', 'https://gotthard.jubr.app/forecasts', 'PAGE-FORECASTS'));
file_put_contents($tmp . '/en/forecasts.html', $page('en', 'Gotthard Traffic Forecast', 'https://gotthard.jubr.app/en/forecasts', 'PAGE-EN-FORECASTS'));
file_put_contents($tmp . '/it.html', $page('it', 'Traffico Gottardo', 'https://gotthard.jubr.app/it', 'PAGE-IT'));
file_put_contents($tmp . '/plain.html', $plain);

// Forecast rows around the real "today" (index.php uses the current time).
$today = new DateTimeImmutable('now', new DateTimeZone('Europe/Zurich'));
$days = [];
for ($i = -1; $i < 10; $i++) {
    $days[] = [
        'date' => $today->modify(($i >= 0 ? '+' : '') . $i . ' day')->format('Y-m-d'),
        'north' => ['peakMin' => 20 + $i, 'peakHour' => 14, 'peakKm' => 2.0, 'busyMin' => 40],
        'south' => ['peakMin' => 0, 'peakHour' => null, 'peakKm' => 0, 'busyMin' => 0],
        'holiday' => null,
    ];
}
file_put_contents($tmp . '/forecast-days.json', json_encode(['generated' => 'x', 'days' => $days]));

file_put_contents($tmp . '/router.php', <<<'PHP'
<?php
// Emulates the .htaccess page rewrite only: "/x" or "/x/y" whose .html exists -> index.php?page=...
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if ($path === '/') { require __DIR__ . '/index.php'; return true; }
if (preg_match('#^/([a-z0-9-]+(?:/[a-z0-9-]+)?)/?$#', $path, $m) && is_file(__DIR__ . '/' . $m[1] . '.html')) {
    $_GET['page'] = $m[1];
    require __DIR__ . '/index.php';
    return true;
}
return false;
PHP);

$port = 18000 + random_int(0, 999);
$proc = proc_open(
    [PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', $tmp, $tmp . '/router.php'],
    [0 => ['pipe', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']],
    $pipes,
);
for ($i = 0; $i < 50; $i++) {
    $s = @fsockopen('127.0.0.1', $port);
    if ($s) {
        fclose($s);
        break;
    }
    usleep(100_000);
}

/** @return array{int, array<string,string>, string} status, lower-cased headers, body */
function req(int $port, string $uri, string $ua = 'test-agent'): array
{
    $ctx = stream_context_create(['http' => ['follow_location' => 0, 'ignore_errors' => true, 'header' => "User-Agent: {$ua}\r\n"]]);
    $body = (string) @file_get_contents("http://127.0.0.1:{$port}{$uri}", false, $ctx);
    $status = 0;
    $headers = [];
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#', $h, $m)) {
            $status = (int) $m[1];
        } elseif (str_contains($h, ':')) {
            [$k, $v] = explode(':', $h, 2);
            $headers[strtolower(trim($k))] = trim($v);
        }
    }
    return [$status, $headers, $body];
}

[$sDe, $hDe, $bDe] = req($port, '/');
[$sEn, , $bEn] = req($port, '/en');
[$sFc, $hFc, $bFc] = req($port, '/forecasts', 'Mozilla/5.0 (compatible; GPTBot/1.2)');
[$sEnFc, , $bEnFc] = req($port, '/en/forecasts');
[$sIt, , $bIt] = req($port, '/it');
[$sPlain, , $bPlain] = req($port, '/plain');
$redir = static fn (string $uri): string => ($r = req($port, $uri))[0] === 301 ? ($r[1]['location'] ?? '?') : 'status ' . $r[0];
$status = static fn (string $uri): int => req($port, $uri)[0];

$assertions = [
    'home de: 200, template, canonical /'       => $sDe === 200 && str_contains($bDe, 'TEMPLATE-DE')
                                                    && str_contains($bDe, '<link rel="canonical" href="https://gotthard.jubr.app/">'),
    'home de: head rewritten, markers filled'   => !str_contains($bDe, '<title>old</title>') && !str_contains($bDe, 'STALE SUMMARY')
                                                    && !str_contains($bDe, '14.07.2026, 19:07'),
    'home de: forecast table for today'         => str_contains($bDe, '<!--SSR:forecast-week--><div class="fc-ssr"><p class="fc-ssr__lead">Prognose heute, ')
                                                    && str_contains($bDe, 'datetime="' . $today->format('Y-m-d') . '">Heute, ')
                                                    && !str_contains($bDe, 'BUILD DAY'),
    'home de: cache headers'                    => ($hDe['cache-control'] ?? '') === 'public, max-age=60',
    'home en: 200, en template, canonical /en'  => $sEn === 200 && str_contains($bEn, 'TEMPLATE-EN')
                                                    && str_contains($bEn, '<link rel="canonical" href="https://gotthard.jubr.app/en">')
                                                    && str_contains($bEn, 'Forecast today, '),
    'forecasts: own title/description/canonical' => $sFc === 200 && str_contains($bFc, '<title>Gotthard Stau Prognose</title>')
                                                    && str_contains($bFc, 'content="Own description"')
                                                    && str_contains($bFc, '<link rel="canonical" href="https://gotthard.jubr.app/forecasts">'),
    'forecasts: live marker filled'             => !str_contains($bFc, 'STALE') && str_contains($bFc, 'id="status-badge" data-status="unknown"'),
    'forecasts: forecast table, de'             => str_contains($bFc, 'Prognose heute, ') && str_contains($bFc, '<td>ca. 20 Min · 14 Uhr</td>'),
    'forecasts: past range emptied'             => str_contains($bFc, '<!--SSR:forecast-range:2000-01-01:2000-01-02--><!--/SSR-->'),
    'forecasts: cache-control'                  => ($hFc['cache-control'] ?? '') === 'public, max-age=60',
    'en/forecasts: own head, english table'     => $sEnFc === 200 && str_contains($bEnFc, '<title>Gotthard Traffic Forecast</title>')
                                                    && str_contains($bEnFc, 'href="https://gotthard.jubr.app/en/forecasts"')
                                                    && str_contains($bEnFc, 'Forecast today, ') && str_contains($bEnFc, '<html lang="en" data-lang="en">'),
    'it: lang kept, english wording fallback'   => $sIt === 200 && str_contains($bIt, '<html lang="it" data-lang="it">')
                                                    && str_contains($bIt, '<title>Traffico Gottardo</title>') && str_contains($bIt, 'Forecast today, '),
    'plain page served unchanged'               => $sPlain === 200 && $bPlain === $plain,
    'crawler log called with page path'         => str_contains((string) @file_get_contents($tmp . '/crawler.log'), 'Mozilla/5.0 (compatible; GPTBot/1.2)|/forecasts'),

    'invalid: ../cron/config -> 404'            => $status('/index.php?page=../cron/config') === 404,
    'invalid: en/../../x -> 404'                => $status('/index.php?page=en/../../x') === 404,
    'invalid: cron/ (not a page dir) -> 404'    => $status('/index.php?page=cron/secret') === 404,
    'invalid: three segments -> 404'            => $status('/index.php?page=a/b/c') === 404,
    'invalid: uppercase -> 404'                 => $status('/index.php?page=Forecasts') === 404,
    'invalid: missing page -> 404'              => $status('/index.php?page=nope') === 404,
    'invalid: array param -> home'              => $status('/index.php?page[]=x') === 200,
    'page=index -> 301 /'                       => $redir('/index.php?page=index') === '/',
    'page=404 -> 404'                           => $status('/index.php?page=404') === 404,

    '?lang=en -> /en'                           => $redir('/?lang=en') === '/en',
    '?lan=en -> /en'                            => $redir('/?lan=en') === '/en',
    '?lang=de -> /'                             => $redir('/?lang=de') === '/',
    '?lang=xx -> /'                             => $redir('/?lang=xx') === '/',
    '/en?lang=de -> /'                          => $redir('/en?lang=de') === '/',
    '/en?lang=en -> /en'                        => $redir('/en?lang=en') === '/en',
    '/forecasts?lang=en -> /forecasts'          => $redir('/forecasts?lang=en') === '/forecasts',
    'trailing slash /en/ -> /en'                => $redir('/en/') === '/en',
    'trailing slash /en/forecasts/ -> no slash' => $redir('/en/forecasts/?a=1') === '/en/forecasts?a=1',
    'other query params do not redirect'        => $status('/?utm_source=x') === 200,
];

proc_terminate($proc);
proc_close($proc);
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($tmp, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
foreach ($it as $f) {
    $f->isDir() ? rmdir($f->getPathname()) : unlink($f->getPathname());
}
rmdir($tmp);

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}
exit($failures > 0 ? 1 : 0);
