<?php
/**
 * Copy this file to config.php (same directory) and fill in your own values.
 * config.php is gitignored - never commit real API credentials.
 *
 * Get a free API token at https://api-manager.opentransportdata.swiss/
 * (register, then subscribe to the "Traffic Situations" / road traffic product).
 */
return [
    // ── DATEX II / opentransportdata.swiss ───────────────────────────────────

    // Full URL of the DATEX II "TrafficSituations" pull endpoint. This is a SOAP
    // service: DatexClient issues a POST with a SOAPAction header and a SOAP
    // envelope body (a plain GET returns HTTP 404).
    'api_url' => 'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull',

    // Most opentransportdata.swiss APIs authenticate via a bearer token OR an
    // Ocp-Apim-Subscription-Key header (Azure API Management). Try Bearer first;
    // if fetch-traffic.php --debug shows a 401/403, switch 'auth_header' below.
    'api_token'   => 'YOUR_API_TOKEN_HERE',
    'auth_header' => 'Authorization', // or 'Ocp-Apim-Subscription-Key'
    'auth_prefix' => 'Bearer ',       // set to '' if using the subscription-key header

    // SOAP request details (defaults match the opentransportdata.swiss cookbook;
    // only override if the portal documents different values for your product).
    'soap_action'  => 'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages',
    'content_type' => 'application/soap+xml', // some tenants expect 'text/xml'

    // Case-insensitive keywords used to find Gotthard-related records in the feed.
    'keywords'      => ['gotthard', 'göschenen', 'goeschenen', 'airolo'],
    'pass_keywords' => ['gotthardpass', 'passstrasse', 'pass strasse', 'passo del gottardo'],

    // ── Secondary pass-status source (alpen-paesse.ch) ────────────────────────
    // Cross-checks / fills the Gotthard PASS status when the DATEX feed carries
    // no pass record (typically summer). DATEX stays authoritative. Set
    // 'pass_source_enabled' => false to disable the extra HTTP request.
    'pass_source_enabled' => true,
    'pass_source_url'     => 'https://www.alpen-paesse.ch/de/alpenpaesse/gotthardpass/',

    // ── Database (MySQL / MariaDB) ────────────────────────────────────────────
    // Run server/schema.sql once to create the required table.

    'db_host' => 'localhost',
    'db_name' => 'YOUR_DATABASE_NAME',
    'db_user' => 'YOUR_DATABASE_USER',
    'db_pass' => 'YOUR_DATABASE_PASSWORD',
    // 'db_port' => 3306,  // uncomment if your host uses a non-standard port

    // ── Error log ─────────────────────────────────────────────────────────────
    // Absolute path where fetch errors are written.
    'error_log' => __DIR__ . '/../data/fetch-error.log',
];
