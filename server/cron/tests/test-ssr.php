<?php

declare(strict_types=1);

/**
 * Tests the server-side render (Ssr::render + index.php) against a small
 * fixture template. Assembles a throw-away deploy dir the same way deploy.yml
 * does (index.php, lib/, translations.json, index.html, en.html).
 *
 * Run: php -d extension=mbstring server/cron/tests/test-ssr.php
 */

$root = dirname(__DIR__, 3);
$tmp  = sys_get_temp_dir() . '/ssr-test-' . bin2hex(random_bytes(4));
mkdir($tmp . '/lib', 0777, true);
copy($root . '/server/index.php', $tmp . '/index.php');
foreach (glob($root . '/server/lib/*.php') as $f) {
    copy($f, $tmp . '/lib/' . basename($f));
}
copy($root . '/site/src/data/translations.json', $tmp . '/translations.json');

/** Stale "July snapshot" template, as the Astro build used to emit it. */
function fixture(string $lang, string $marker): string
{
    return <<<HTML
<!doctype html>
<html lang="{$lang}" data-lang="{$lang}"><head>
<title>old</title>
<meta name="description" content="old">
<meta property="og:title" content="old"><meta property="og:description" content="old"><meta property="og:url" content="old">
<meta name="twitter:title" content="old"><meta name="twitter:description" content="old">
<link rel="canonical" href="https://stale.example/old">
<script type="application/ld+json" id="ld-traffic">{}</script>
</head><body>
<!-- {$marker} -->
<div class="status-badge" id="status-badge" data-status="congested"><span id="status-label"><!--SSR:status-label-->STALE<!--/SSR--></span></div>
<p id="summary"><!--SSR:summary-->STALE SUMMARY<!--/SSR--></p>
<time id="hero-updated" datetime="2026-07-14T19:07:00Z"><!--SSR:updated-human-->14.07.2026, 19:07<!--/SSR--></time>
<section id="planned-closures" hidden></section>
<article>
  <span id="north-queue"><!--SSR:north-queue-->4.5 km<!--/SSR--></span>
  <span id="north-trend" hidden><!--SSR:north-trend-->STALE<!--/SSR--></span>
  <span id="north-wait"><!--SSR:north-wait-->45 min<!--/SSR--></span>
  <div id="north-cause-row"><p id="north-cause"><!--SSR:north-cause-->Hohes Verkehrsaufkommen<!--/SSR--></p></div>
  <span id="north-free" hidden>free</span>
  <div class="meter"><div id="north-meter" style="width:30%"></div></div>
</article>
<article>
  <span id="south-queue"><!--SSR:south-queue-->0 km<!--/SSR--></span>
  <span id="south-trend" hidden><!--SSR:south-trend--><!--/SSR--></span>
  <span id="south-wait"><!--SSR:south-wait-->–<!--/SSR--></span>
  <div id="south-cause-row"><p id="south-cause"><!--SSR:south-cause-->STALE SOUTH CAUSE<!--/SSR--></p></div>
  <span id="south-free" hidden>free</span>
  <div class="meter"><div id="south-meter"></div></div>
</article>
<span id="pass-status-label"><!--SSR:pass-status-label-->Offen<!--/SSR--></span>
<div id="pass-badge" data-status="open"></div>
<div id="pass-note-row"><p id="pass-note"><!--SSR:pass-note-->STALE PASS NOTE<!--/SSR--></p></div>
</body></html>
HTML;
}

file_put_contents($tmp . '/index.html', fixture('de', 'TEMPLATE-DE'));
file_put_contents($tmp . '/en.html', fixture('en', 'TEMPLATE-EN'));

require_once $tmp . '/lib/Ssr.php';
require_once $tmp . '/lib/SnapshotMapper.php';

// (a) calm row: no queue, no cause, no pass note, no planned closures.
$calmRow = [
    'fetched_at' => '2026-11-09 20:00:00', 'tunnel_status' => 'open', 'closure_reason' => null,
    'north_queue_km' => '0', 'north_wait_min' => null, 'north_cause' => null,
    'south_queue_km' => '0.0', 'south_wait_min' => null, 'south_cause' => '',
    'pass_status' => 'closed', 'pass_note' => null, 'planned_closures' => null,
];
// (b) closed row with planned closures and a queue with unknown wait time.
$closedRow = [
    'fetched_at' => '2026-11-09 20:00:00', 'tunnel_status' => 'closed', 'closure_reason' => 'Pannenfahrzeug',
    'north_queue_km' => '20', 'north_wait_min' => null, 'north_cause' => 'Stau <b>x</b>',
    'south_queue_km' => '1.5', 'south_wait_min' => '12', 'south_cause' => null,
    'pass_status' => 'open', 'pass_note' => 'Passstrasse offen',
    'planned_closures' => json_encode([
        ['from' => '2030-07-15T19:00:00Z', 'to' => '2030-07-15T20:30:00Z', 'cause' => 'Sondertransport'],
        ['from' => '2030-07-16T21:00:00Z', 'to' => null, 'cause' => '<script>alert(1)</script>'],
    ]),
];

$calm   = SnapshotMapper::fromRow($calmRow);
$closed = SnapshotMapper::fromRow($closedRow);
$tplDe  = (string) file_get_contents($tmp . '/index.html');

$rCalm   = Ssr::render($tplDe, $calm, 'de', 'https://gotthard.jubr.app/');
$rClosed = Ssr::render($tplDe, $closed, 'de', 'https://gotthard.jubr.app/');
$rClosedEn = Ssr::render((string) file_get_contents($tmp . '/en.html'), $closed, 'en', 'https://gotthard.jubr.app/en');

// Minified template as Astro's compressHTML emits it: empty attributes become
// bare (`datetime`, `hidden`), single quotes, plus traps (data-id, "hidden" inside
// another attribute's value) that must not be touched.
$minified = '<html lang="de" data-lang="de"><body>'
    . '<time id="hero-updated" datetime><!--SSR:updated-human-->x<!--/SSR--></time>'
    . '<span class="chip" data-id="status-badge" id="status-badge" data-status>s</span>'
    . '<span id="pass-badge" data-status=\'open\' aria-label="is hidden now">p</span>'
    . '<p class="card__cause" id="pass-note-row" hidden=""><span id="pass-note"><!--SSR:pass-note-->n<!--/SSR--></span></p>'
    . '<span id="north-free" hidden="hidden">free</span>'
    . '<div id="north-meter" style>m</div>'
    . '</body></html>';
$rMin = Ssr::render($minified, $closed, 'de', 'https://gotthard.jubr.app/');

/** Runs the real index.php with a given lang / hostile Host header and returns [headers-free body]. */
function run_index(string $dir, string $lang, string $uri): string
{
    $code = '$_GET = ' . ($lang === '' ? '[]' : "['lang' => '{$lang}']") . ';'
        . '$_SERVER["HTTP_HOST"] = "evil.example"; $_SERVER["REQUEST_URI"] = ' . var_export($uri, true) . ';'
        . 'chdir(' . var_export($dir, true) . '); require ' . var_export($dir . '/index.php', true) . ';';
    return (string) shell_exec('php -d extension=mbstring -d display_errors=0 -r ' . escapeshellarg($code) . ' 2>&1');
}

$outDe = run_index($tmp, '', '/index.php/foo');
$outEn = run_index($tmp, 'en', '/en');

$assertions = [
    'mapper keeps plannedClosures'              => count($closed['tunnel']['plannedClosures']) === 2,
    'mapper: no planned closures -> []'         => $calm['tunnel']['plannedClosures'] === [],

    // (a) calm row
    'calm: stale updated time gone'             => !str_contains($rCalm, '14.07.2026, 19:07'),
    'calm: updated is 09.11.2026, 21:00 (Zurich)' => str_contains($rCalm, '<!--SSR:updated-human-->09.11.2026, 21:00<!--/SSR-->'),
    'calm: stale summary gone'                  => !str_contains($rCalm, 'STALE SUMMARY'),
    'calm: stale north cause cleared'           => !str_contains($rCalm, 'Hohes Verkehrsaufkommen'),
    'calm: north cause marker empty'            => str_contains($rCalm, '<!--SSR:north-cause--><!--/SSR-->'),
    'calm: south cause cleared'                 => !str_contains($rCalm, 'STALE SOUTH CAUSE'),
    'calm: pass note cleared'                   => !str_contains($rCalm, 'STALE PASS NOTE'),
    'calm: stale trend cleared'                 => !str_contains($rCalm, 'STALE</'),
    'calm: north-cause-row hidden'              => (bool) preg_match('/id="north-cause-row"[^>]*\bhidden\b/', $rCalm),
    'calm: south-cause-row hidden'              => (bool) preg_match('/id="south-cause-row"[^>]*\bhidden\b/', $rCalm),
    'calm: pass-note-row hidden'                => (bool) preg_match('/id="pass-note-row"[^>]*\bhidden\b/', $rCalm),
    'calm: north-free visible'                  => !preg_match('/id="north-free"[^>]*\bhidden\b/', $rCalm),
    'calm: south-free visible'                  => !preg_match('/id="south-free"[^>]*\bhidden\b/', $rCalm),
    'calm: planned-closures hidden'             => (bool) preg_match('/id="planned-closures"[^>]*\bhidden\b/', $rCalm),
    'calm: meter width 0%'                      => str_contains($rCalm, 'id="north-meter" style="width:0%"'),
    'calm: meter style added when absent'       => str_contains($rCalm, 'id="south-meter" style="width:0%"'),
    'calm: status badge data-status=open'       => str_contains($rCalm, 'id="status-badge" data-status="open"'),
    'calm: pass badge data-status=closed'       => str_contains($rCalm, 'id="pass-badge" data-status="closed"'),
    'calm: summary has no "ca. –"'              => !str_contains($rCalm, 'ca. –'),

    // (b) closed row with planned closures
    'closed: summary names closure reason'      => str_contains($rClosed, 'Gotthard-Strassentunnel gesperrt (Pannenfahrzeug).'),
    'closed: north cause escaped'               => str_contains($rClosed, 'Stau &lt;b&gt;x&lt;/b&gt;') && !str_contains($rClosed, '<b>x</b>'),
    'closed: cause rows visible/hidden'         => !preg_match('/id="north-cause-row"[^>]*\bhidden\b/', $rClosed)
                                                    && (bool) preg_match('/id="south-cause-row"[^>]*\bhidden\b/', $rClosed),
    'closed: pass note shown'                   => str_contains($rClosed, '<!--SSR:pass-note-->Passstrasse offen<!--/SSR-->')
                                                    && !preg_match('/id="pass-note-row"[^>]*\bhidden\b/', $rClosed),
    'closed: free badges hidden'                => (bool) preg_match('/id="north-free"[^>]*\bhidden\b/', $rClosed)
                                                    && (bool) preg_match('/id="south-free"[^>]*\bhidden\b/', $rClosed),
    'closed: meter capped at 100%'              => str_contains($rClosed, 'id="north-meter" style="width:100%"'),
    'closed: south meter 10%'                   => str_contains($rClosed, 'id="south-meter" style="width:10%"'),
    'closed: planned banner visible'            => !preg_match('/id="planned-closures"[^>]*\bhidden\b/', $rClosed),
    'closed: planned banner has 2 items'        => substr_count($rClosed, 'closure-banner__item') === 2,
    'closed: planned closure detail rendered'   => str_contains($rClosed, 'Sondertransport – 15.07., 21:00–22:30'),
    'closed: planned closure text escaped'      => !str_contains($rClosed, '<script>alert(1)</script>')
                                                    && str_contains($rClosed, '&lt;script&gt;alert(1)&lt;/script&gt;'),
    'format: summary w/o wait (open, queue)'    => !str_contains(Format::summary(array_replace_recursive($calm, ['tunnel' => ['north' => ['queueKm' => 3.0]]]), 'de'), 'ca.')
                                                    && str_contains(Format::summary(array_replace_recursive($calm, ['tunnel' => ['north' => ['queueKm' => 3.0]]]), 'de'), '3.0 km Rückstau am Nordportal (Göschenen)'),
    'format: summary with wait'                 => str_contains(Format::summary(array_replace_recursive($calm, ['tunnel' => ['south' => ['queueKm' => 2.0, 'waitMinutes' => 12]]]), 'de'), 'ca. 12 Min Wartezeit'),
    'closed: english closure title'             => str_contains($rClosedEn, 'Planned tunnel closure'),
    'canonical fixed (given url)'               => str_contains($rClosed, '<link rel="canonical" href="https://gotthard.jubr.app/">')
                                                    && str_contains($rClosedEn, '<link rel="canonical" href="https://gotthard.jubr.app/en">'),

    // minified (compressHTML) attribute forms
    'min: bare datetime replaced, not duplicated' => str_contains($rMin, '<time id="hero-updated" datetime="2026-11-09T20:00:00+00:00">')
                                                    && substr_count($rMin, 'datetime') === 1,
    'min: bare data-status replaced once'       => str_contains($rMin, 'id="status-badge" data-status="closed">')
                                                    && substr_count($rMin, 'data-status="closed"') === 1
                                                    && str_contains($rMin, 'data-id="status-badge"'),
    'min: single-quoted data-status replaced'   => str_contains($rMin, '<span id="pass-badge" data-status="open" aria-label="is hidden now">'),
    'min: hidden="" removed when note present'  => str_contains($rMin, '<p class="card__cause" id="pass-note-row">'),
    'min: hidden="hidden" normalised'           => str_contains($rMin, '<span id="north-free" hidden>'),
    'min: bare style replaced'                  => str_contains($rMin, '<div id="north-meter" style="width:100%">'),

    // index.php end to end (no cron/config.php -> default data, which must still replace stale markers)
    'index.php de: uses index.html template'    => str_contains($outDe, 'TEMPLATE-DE') && !str_contains($outDe, 'TEMPLATE-EN'),
    'index.php de: canonical fixed, no host'    => str_contains($outDe, '<link rel="canonical" href="https://gotthard.jubr.app/">')
                                                    && !str_contains($outDe, 'evil.example') && !str_contains($outDe, 'index.php'),
    'index.php de: stale snapshot gone'         => !str_contains($outDe, '14.07.2026, 19:07') && !str_contains($outDe, 'Hohes Verkehrsaufkommen'),
    'index.php en: uses en.html template'       => str_contains($outEn, 'TEMPLATE-EN') && !str_contains($outEn, 'TEMPLATE-DE'),
    'index.php en: no redirect, html lang=en'   => str_contains($outEn, '<html lang="en" data-lang="en">'),
    'index.php en: canonical is /en'            => str_contains($outEn, '<link rel="canonical" href="https://gotthard.jubr.app/en">')
                                                    && !str_contains($outEn, 'evil.example'),
    'index.php en: english text'                => str_contains($outEn, 'Gotthard'),
];

// cleanup
foreach (array_merge(glob($tmp . '/lib/*') ?: [], glob($tmp . '/*') ?: []) as $f) {
    if (is_file($f)) {
        unlink($f);
    }
}
@rmdir($tmp . '/lib');
@rmdir($tmp);

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}

exit($failures > 0 ? 1 : 0);
