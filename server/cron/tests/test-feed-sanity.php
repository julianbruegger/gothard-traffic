<?php

declare(strict_types=1);

/** #60: empty/faulty feed gate, queue without figures, collector state + log rotation. */
require __DIR__ . '/../lib/TrafficParser.php';
require __DIR__ . '/../lib/CollectorState.php';

$config = require __DIR__ . '/../config.example.php';
$parser = new TrafficParser($config);

$empty = '<?xml version="1.0" encoding="utf-8"?><d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication/></d2LogicalModel>';
$fault = '<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Server</faultcode><faultstring>Backend down</faultstring></soap:Fault></soap:Body></soap:Envelope>';
$noFigures = <<<'XML'
<?xml version="1.0" encoding="utf-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>
  <situation><situationRecord xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Luzern -&gt; Gotthard zwischen Anschluss Wassen und Parkplatz Dosierstelle Göschenen Sachlage: stockender Verkehr Ursache: Verkehrsüberlastung</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>
</payloadPublication></d2LogicalModel>
XML;

$emptyResult = $parser->parse($empty);
$gateEmpty = false;
try {
    TrafficParser::assertFeedSane($emptyResult, $config);
} catch (TrafficParseException) {
    $gateEmpty = true;
}
$gateLow = false;
try {
    TrafficParser::assertFeedSane(['recordCount' => 5], ['min_feed_records' => 20]);
} catch (TrafficParseException) {
    $gateLow = true;
}
$gateOk = true;
try {
    TrafficParser::assertFeedSane(['recordCount' => 300], []);
} catch (TrafficParseException) {
    $gateOk = false;
}
$faultThrown = false;
try {
    $parser->parse($fault);
} catch (TrafficParseException $e) {
    $faultThrown = str_contains($e->getMessage(), 'Backend down');
}

$nf = $parser->parse($noFigures)['tunnel'];

// Collector state + alert logic
$dir = sys_get_temp_dir() . '/gt-state-' . getmypid();
@mkdir($dir);
$sf = $dir . '/state.json';
$st = new CollectorState($sf);
$alerts = [];
for ($i = 1; $i <= 7; $i++) {
    $alerts[] = $st->recordFailure('boom', 5);
}
$st2 = new CollectorState($sf); // reloaded from disk
$recovered = $st2->recordSuccess('2026-11-12T10:00:00+00:00');
$recoveredAgain = $st2->recordSuccess('2026-11-12T10:03:00+00:00');

file_put_contents($dir . '/err.log', str_repeat('x', 2000));
$rotated = CollectorState::rotateLog($dir . '/err.log', 1000);
$notRotated = CollectorState::rotateLog($dir . '/missing.log', 1000);

$checks = [
    'empty feed -> recordCount 0'         => $emptyResult['recordCount'] === 0,
    'empty feed rejected by gate'         => $gateEmpty,
    'below floor rejected'                => $gateLow,
    'healthy feed accepted'               => $gateOk,
    'SOAP fault throws'                   => $faultThrown,
    'queue without figures -> congested'  => $nf['status'] === 'congested' && $nf['north']['queueKm'] === null,
    'queue cause kept'                    => $nf['north']['cause'] === 'Verkehrsüberlastung',
    'alert fires once at threshold'       => $alerts === [false, false, false, false, true, false, false],
    'state persisted failures'            => (new CollectorState($sf))->get('consecutiveFailures') === 0 && $st2->get('lastSuccess') !== null,
    'recovery signalled once'             => $recovered === true && $recoveredAgain === false,
    'log rotated when oversized'          => $rotated && is_file($dir . '/err.log.1') && !is_file($dir . '/err.log'),
    'missing log not rotated'             => $notRotated === false,
];

array_map('unlink', glob($dir . '/*') ?: []);
@rmdir($dir);

$failures = 0;
foreach ($checks as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}\n";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
