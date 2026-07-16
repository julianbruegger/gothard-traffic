<?php

declare(strict_types=1);

/**
 * Focused test for an UNPLANNED full tunnel closure (e.g. a broken-down
 * vehicle). Unlike a planned special transport, the live feed names the bore
 * directly ("Gotthard Tunnel Gotthard-Tunnel … Tunnel gesperrt") and mentions
 * neither portal town, so the old göschenen+airolo gate missed it entirely.
 *
 * The fixture is inline (a closure sets status=closed, which is mutually
 * exclusive with the "congested" scenario in sample-datex2.xml) and mixes in
 * records that must NOT be mistaken for a Gotthard-tunnel closure.
 */

require __DIR__ . '/../lib/TrafficParser.php';

$config = require __DIR__ . '/../config.example.php';

// German + French value texts are concatenated with no separator in the real
// feed ("…PannenfahrzeugLibéré:…"), which also exercises the cause extractor.
$xml = <<<'XML'
<?xml version="1.0" encoding="utf-8"?>
<d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0">
 <payloadPublication>
  <situation><situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Chiasso &lt;-&gt; Gotthard Tunnel Gotthard-Tunnel Sachlage: Tunnel gesperrt Ursache: Pannenfahrzeug</value>
     <value lang="fr">Libéré: A2 Chiasso &lt;-&gt; St-Gothard Tunnel Tunnel du St-Gothard Situation: tunnel fermé Raison: véhicule en panne</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>

  <situation><situationRecord xsi:type="AbnormalTraffic" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <abnormalTrafficType>stationaryTraffic</abnormalTrafficType>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Luzern -&gt; Gotthard zwischen Anschluss Wassen und Parkplatz Dosierstelle Göschenen Sachlage: Stau Länge [km] 3 Ursache: Verkehrsüberlastung Zusatz 1: Zeitverlust Anz. [min] 25</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>

  <situation><situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Chiasso -&gt; Gotthard Anschluss Airolo Sachlage: Einfahrt gesperrt</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>

  <situation><situationRecord xsi:type="RoadOrCarriagewayOrLaneManagement" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Gotthard -&gt; Luzern Tunnel Seelisberg-Tunnel Sachlage: Tunnel gesperrt Ursache: Unfall</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>
 </payloadPublication>
</d2LogicalModel>
XML;

$parser = new TrafficParser($config);
$result = $parser->parse($xml);

echo json_encode($result['tunnel'], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";

$assertions = [
    'tunnel.status == closed'            => $result['tunnel']['status'] === 'closed',
    'closureReason == Pannenfahrzeug'    => ($result['tunnel']['closureReason'] ?? null) === 'Pannenfahrzeug',
    // An incident carries no end time → reopening is unknown.
    'closureUntil is null (incident)'    => ($result['tunnel']['closureUntil'] ?? 'x') === null,
    // Queues still parse while the tunnel is closed (approach jams build up).
    'north.queueKm == 3.0'               => $result['tunnel']['north']['queueKm'] === 3.0,
    'north.waitMinutes == 25'            => $result['tunnel']['north']['waitMinutes'] === 25,
    // Ramp closure ("Einfahrt gesperrt") and the Seelisberg bore must NOT be
    // read as a Gotthard tunnel closure. Only the closure + north queue match.
    'debug matched 2 records'            => count($result['debug']) === 2,
    'no planned closures'                => count($result['tunnel']['plannedClosures']) === 0,
];

$failures = 0;
foreach ($assertions as $label => $passed) {
    echo ($passed ? 'PASS' : 'FAIL') . ": {$label}\n";
    if (!$passed) {
        $failures++;
    }
}

exit($failures > 0 ? 1 : 0);
