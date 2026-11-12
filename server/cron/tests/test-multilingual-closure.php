<?php

declare(strict_types=1);

/** #51: multilingual pass note, suspended closures, multi-period planned closures. */
require __DIR__ . '/../lib/TrafficParser.php';

$config = require __DIR__ . '/../config.example.php';

$passRecord = <<<'XML'
  <situation><situationRecord xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>active</validityStatus>
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: H2 Airolo &lt;-&gt; Göschenen Pass Gotthard-Pass Sachlage: Strecke gesperrt Ursache: Wintersperre</value>
     <value lang="fr">Libéré: H2 Airolo &lt;-&gt; Göschenen Col Col du St-Gothard Situation: fermé Raison: fermeture hiverna</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>
XML;

function closure(string $status, string $periods): string
{
    return <<<XML
  <situation><situationRecord xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
   <validityStatus>{$status}</validityStatus>
   {$periods}
   <generalPublicComment><comment><values>
     <value lang="de">Freigegeben: A2 Chiasso &lt;-&gt; Gotthard Tunnel Gotthard-Tunnel Sachlage: Tunnel gesperrt Ursache: Ausnahmetransport</value>
   </values></comment></generalPublicComment>
  </situationRecord></situation>
XML;
}

function wrap(string ...$records): string
{
    return '<?xml version="1.0" encoding="utf-8"?><d2LogicalModel xmlns="http://datex2.eu/schema/2/2_0"><payloadPublication>'
        . implode('', $records) . '</payloadPublication></d2LogicalModel>';
}

$period = static fn (string $a, string $b): string =>
    "<validPeriod><startOfPeriod>{$a}</startOfPeriod><endOfPeriod>{$b}</endOfPeriod></validPeriod>";

$parser = new TrafficParser($config);

$pass = $parser->parse(wrap($passRecord))['pass'];

$suspended = $parser->parse(wrap(closure('suspended', '')))['tunnel'];
$active = $parser->parse(wrap(closure('active', '')))['tunnel'];

$past = (new DateTimeImmutable('-3 days'))->format('Y-m-d\TH:i:s\Z');
$pastEnd = (new DateTimeImmutable('-2 days'))->format('Y-m-d\TH:i:s\Z');
$f1 = (new DateTimeImmutable('+2 days'))->format('Y-m-d\T23:00:00\Z');
$f1e = (new DateTimeImmutable('+3 days'))->format('Y-m-d\T01:00:00\Z');
$f2 = (new DateTimeImmutable('+5 days'))->format('Y-m-d\T23:00:00\Z');
$f2e = (new DateTimeImmutable('+6 days'))->format('Y-m-d\T01:00:00\Z');
$multi = $parser->parse(wrap(closure('active', $period($past, $pastEnd) . $period($f1, $f1e) . $period($f2, $f2e))))['tunnel'];

$many = '';
for ($i = 1; $i <= 5; $i++) {
    $many .= $period((new DateTimeImmutable("+{$i} days"))->format('Y-m-d\T22:00:00\Z'), (new DateTimeImmutable("+{$i} days"))->format('Y-m-d\T23:30:00\Z'));
}
$capped = $parser->parse(wrap(closure('active', $many)))['tunnel'];

$long = TrafficParser::passNote('Sachlage: ' . str_repeat('Wort ', 60) . 'Ursache: X');

$checks = [
    'pass closed'                        => $pass['status'] === 'closed',
    'pass note is clean German'          => $pass['note'] === 'Strecke gesperrt – Wintersperre',
    'pass note has no French'            => !str_contains((string) $pass['note'], 'Libéré') && !str_contains((string) $pass['note'], 'hiverna'),
    'germanPart cuts at boundary'        => TrafficParser::germanPart('Abc Def Révoqué: xyz') === 'Abc Def',
    'long note truncated on word'        => mb_strlen((string) $long) <= 160 && str_ends_with((string) $long, '…') && !str_contains((string) $long, 'Wor…'),
    'suspended closure not closed'       => $suspended['status'] === 'open' && $suspended['plannedClosures'] === [],
    'active closure is closed'           => $active['status'] === 'closed' && $active['closureReason'] === 'Ausnahmetransport',
    'past+2 future periods -> 2 planned' => count($multi['plannedClosures']) === 2 && $multi['status'] === 'open',
    'planned sorted, first = f1'         => str_starts_with($multi['plannedClosures'][0]['from'] ?? '', substr($f1, 0, 13)),
    'planned capped at 3'                => count($capped['plannedClosures']) === 3,
];

$failures = 0;
foreach ($checks as $label => $ok) {
    echo ($ok ? 'PASS' : 'FAIL') . ": {$label}\n";
    $failures += $ok ? 0 : 1;
}
exit($failures > 0 ? 1 : 0);
