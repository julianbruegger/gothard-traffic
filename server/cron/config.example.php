<?php
/**
 * Copy this file to config.php (same directory) and fill in your own values.
 * config.php is gitignored - never commit real API credentials.
 *
 * Get a free API token at https://api-manager.opentransportdata.swiss/
 * (register, then subscribe to the "Traffic Situations" / road traffic product).
 */
return [
    // Full URL of the DATEX II "TrafficSituations" pull endpoint.
    'api_url' => 'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull',

    // Most opentransportdata.swiss APIs authenticate via a bearer token OR an
    // Ocp-Apim-Subscription-Key header (Azure API Management). Try Bearer first;
    // if fetch-traffic.php --debug shows a 401/403, switch 'auth_header' below.
    'api_token' => 'YOUR_API_TOKEN_HERE',
    'auth_header' => 'Authorization', // or 'Ocp-Apim-Subscription-Key'
    'auth_prefix' => 'Bearer ',       // set to '' if using the subscription-key header

    // Case-insensitive keywords used to find Gotthard-related records in the feed.
    'keywords' => ['gotthard', 'göschenen', 'goeschenen', 'airolo'],

    // Keywords that identify the Gotthard Pass (mountain road) rather than the tunnel.
    'pass_keywords' => ['gotthardpass', 'passstrasse', 'pass strasse', 'passo del gottardo'],

    // Where JSON output is written. Defaults to ../data relative to this folder,
    // i.e. the "data" folder is a sibling of this "cron" folder in the web root.
    'data_dir' => __DIR__ . '/../data',

    // How long (hours) to keep history points before pruning.
    'history_retention_hours' => 48,

    // Minimum minutes between history points actually stored (avoids bloating
    // history.json if the cron job runs very frequently).
    'history_min_interval_minutes' => 10,
];
