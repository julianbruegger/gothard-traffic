<?php

declare(strict_types=1);

/** Roadworks closure valid for weeks but only 20:00-06:00 daily: not "closed" at midday. */
require __DIR__ . '/../lib/TrafficParser.php';

$config = require __DIR__ . '/../config.example.php';
$xml = <<<'XML'
<?xml version="1.0" encoding="utf-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
 <payloadPublication>
  <situation><situationRecord xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <validPeriod><startOfPeriod>2020-01-01T00:00:00Z</startOfPeriod><endOfPeriod>2099-01-01T00:00:00Z</endOfPeriod>
    <recurringTimePeriodOfDay><startTimeOfPeriod>%START%</startTimeOfPeriod><endTimeOfPeriod>%END%</endTimeOfPeriod></recurringTimePeriodOfDay>
   </validPeriod>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Chiasso &lt;-&gt; Gotthard Tunnel Gotthard-Tunnel Sachlage: Tunnel gesperrt Ursache: Tunnel gesperrt Baustelle,</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>
 </payloadPublication>
</d2LogicalModel>
XML;

$tz = new DateTimeZone('Europe/Zurich');
$now = new DateTimeImmutable('now', $tz);
$fmt = fn (DateTimeImmutable $d) => $d->format('H:i:s');
// Window that surely contains now, and one that surely excludes it.
$in  = str_replace(['%START%', '%END%'], [$fmt($now->modify('-1 hour')), $fmt($now->modify('+1 hour'))], $xml);
$out = str_replace(['%START%', '%END%'], [$fmt($now->modify('+2 hours')), $fmt($now->modify('+3 hours'))], $xml);

$parser = new TrafficParser($config);
$rIn = $parser->parse($in)['tunnel'];
$rOut = $parser->parse($out)['tunnel'];

$assertions = [
    'inside daily window -> closed'  => $rIn['status'] === 'closed',
    'cause cleaned to Baustelle'     => $rIn['closureReason'] === 'Baustelle',
    'outside daily window -> open'   => $rOut['status'] === 'open',
    'outside window -> next window planned' => count($rOut['plannedClosures']) === 1
        && new DateTimeImmutable($rOut['plannedClosures'][0]['from']) > new DateTimeImmutable('now')
        && new DateTimeImmutable($rOut['plannedClosures'][0]['from']) <= new DateTimeImmutable('+3 hours 1 minute')
        && ($rOut['plannedClosures'][0]['cause'] ?? null) === 'Baustelle',
    'inside window -> no planned entry' => count($rIn['plannedClosures']) === 0,
];
$failures = 0;
foreach ($assertions as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}
";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
