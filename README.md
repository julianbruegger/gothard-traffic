# Gotthard Traffic Live

Live queue length, waiting time and road status for the Gotthard road tunnel
(north portal Göschenen / south portal Airolo) and the Gotthard Pass, plus a
traffic forecast. German and English. Built for **plain PHP + MySQL web
hosting with no Node.js at runtime**.

Live site: https://gotthard.jubr.app

This is an independent, unofficial project, not affiliated with ASTRA or any
Swiss authority. Do not rely on it for safety-critical decisions.

## How it works

```
 opentransportdata.swiss (DATEX II)      alpen-paesse.ch (pass status, fallback)
              │                                   │
              └──────────────┬────────────────────┘
                             ▼
        cron/fetch-traffic.php   (every ~3 minutes; weather hourly, Open-Meteo)
                             │ INSERT
                             ▼
              MySQL / MariaDB: gotthard_snapshots, gotthard_weather
                             │                         (server/schema.sql)
          ┌──────────────────┴───────────────────┐
          ▼                                      ▼
  api/*.php (JSON)                         index.php (SSR)
                                           takes the built index.html and
          ▲                                injects live status into title,
          │ polled every 60 s              meta tags, JSON-LD and the visible
     browser JS (live.ts)                  numbers, so crawlers without
                                           JavaScript see current data
```

Node/npm is only needed to build the static frontend (`astro build`) locally
or in CI. The host only needs PHP, MySQL and cron.

## Repository layout

| Path | Purpose |
| --- | --- |
| `site/` | Astro project (static frontend). `npm run build` writes `site/dist/`. |
| `site/src/pages/` | `/`, `/forecasts`, `/statistics`, `/nerd` and the English `/en/...` equivalents. |
| `site/src/data/` | `translations.json` (de/en strings) and generated forecast data, see [docs/data-pipeline.md](docs/data-pipeline.md). |
| `site/public/` | `robots.txt`, `llms.txt`, icons, manifest, sample data for local dev. |
| `server/index.php`, `server/lib/` | PHP SSR wrapper and helpers (i18n, DB, formatting). |
| `server/api/` | JSON endpoints backed by the database. |
| `server/cron/` | The collector (`fetch-traffic.php`), DATEX/pass/weather clients, parser, `migrate.php` and tests. |
| `server/schema.sql` | Database schema (`gotthard_snapshots`, `gotthard_weather`). |
| `.github/workflows/` | `ci.yml` (PHP lint and tests, Astro build), `deploy.yml`, `backtest.yml` (forecast backtest). |
| `.github/workflows/deploy.yml` | Build and deploy over SSH/rsync. |

## Setup

### 1. API token

1. Register at https://api-manager.opentransportdata.swiss/ and subscribe to
   the "Traffic Situations" (road traffic) product.
2. Keep the token for step 3 (or the `DATEX_API_TOKEN` secret for CI).

### 2. Database

Create a MySQL 5.7+ / MariaDB 10.3+ database and load the schema once:

```bash
mysql -u USER -p DATABASE < server/schema.sql
```

The collector inserts one row per run into `gotthard_snapshots` (full history
for the API, statistics and forecast) and hourly weather into
`gotthard_weather`. On existing installs `php server/cron/migrate.php`
creates missing tables and applies additive column migrations; the deploy runs
it automatically.

### 3. Configuration

```bash
cp server/cron/config.example.php server/cron/config.php
```

Fill in `api_token`, `db_host`, `db_name`, `db_user`, `db_pass`. `config.php`
is gitignored. The deploy workflow generates it from secrets (see below).

### 4. Cron

Run the collector every 3 minutes on the host:

```
*/3 * * * * php /path/to/webroot/cron/fetch-traffic.php >> /path/to/webroot/cron/cron.log 2>&1
```

Check parsing against the live feed with `php server/cron/fetch-traffic.php --debug`
and inspect unmatched records with `php server/cron/diagnose.php`. To load the
last 90 days of weather once: `php cron/fetch-traffic.php --backfill-weather`.
Optional settings (failure alert mail, health threshold, retention, weather
switch) are documented in `config.example.php`.

## Local development

```bash
cd site
npm install
npm run dev        # http://localhost:4321
npm run build      # astro check + build -> site/dist/
npm run check:seo  # after build: unique titles/descriptions, llms.txt URLs exist
```

Without PHP, the browser falls back to the sample data in
`site/public/data/*.json` (never deployed). `npm run fetch` refreshes those
sample files from the live feed (needs `DATEX_API_TOKEN` in `site/.env`).

## Tests

PHP tests live in `server/cron/tests/` (they also cover `server/lib/`). Run all
of them, exactly as CI does:

```bash
for t in server/cron/tests/test-*.php; do php "$t" || exit 1; done
```

The forecast model has a backtest: `cd site && npm run backtest`.

## Deployment (GitHub Actions)

`.github/workflows/deploy.yml` runs on push to `main` (after CI, environment
`Hostpoint`). It builds the site, assembles `index.php`, `lib/`, `api/`,
`translations.json` and `cron/` (with `schema.sql`), writes `cron/config.php`
from secrets, rsyncs the result over SSH (keeping the server's `data/` folder),
runs `php cron/migrate.php` and finishes with a smoke test.

Secrets (environment `Hostpoint`):

| Secret | Meaning |
| --- | --- |
| `DATEX_API_TOKEN` | opentransportdata.swiss API token |
| `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS` | database credentials |
| `HOSTPOINT_HOST`, `HOSTPOINT_USER`, `HOSTPOINT_SSH_KEY`, `HOSTPOINT_PATH`, `HOSTPOINT_KNOWN_HOSTS` | SSH target, web root and pinned host key |

You still create the (empty) database and add the cron job once on the host;
tables are created by `migrate.php` during the deploy.

### Privacy and security headers

- The browser contacts only the site's own origin: the Roboto Flex font is
  self-hosted (`@fontsource-variable/roboto-flex`, SIL OFL 1.1) and third-party
  data goes through `api/*.php`. Keep it that way; `npm run check:seo` fails on
  any reference to Google Fonts.
- `site/public/.htaccess` sets HSTS, a Content-Security-Policy and other
  security headers. The inline-script hashes in the CSP are filled in after
  every build by `site/scripts/csp-hashes.mjs` (part of `npm run build`).
  The CSP currently ships as `Content-Security-Policy-Report-Only`; once the
  browser console is clean on all pages on the live host, switch to the
  enforcing line right below it in `.htaccess`.
- The privacy notice (`/privacy`, `/en/privacy`) is a draft: the operator name,
  contact address and log retention are placeholders in
  `site/src/components/PrivacyContent.astro` and must be filled in and reviewed.

## Pages and API

| URL | Content |
| --- | --- |
| `/`, `/en` | Live dashboard (status, queues, pass, planned closures, trend, FAQ) |
| `/forecasts`, `/en/forecasts` | Forecast by weekday, time of day and holidays |
| `/statistics`, `/en/statistics` | Historic statistics from TCS reports (busiest weekdays, Easter records) |
| `/nerd`, `/en/nerd` | Nerd Mode: 365-day records, heatmap, minutes per km, closures, weather, CSV |
| `/api/gotthard.php` | Current status (JSON) |
| `/api/history.php` | Last 24 h of snapshots (JSON array) |
| `/api/stats.php` | Aggregated 365-day statistics (JSON, cached 15 min) |
| `/api/observed.php` | Per-day hourly queues for the forecast model (JSON, cached 1 h) |
| `/api/health.php` | Collector health for uptime monitors (HTTP 503 when stale) |
| `/api/holidays.php`, `/api/train.php` | Cached proxies for school holidays and the next Göschenen-Airolo train |

Example `/api/gotthard.php` response:

```json
{
  "updated": "2026-11-11T09:27:03+00:00",
  "source": "opentransportdata.swiss (ASTRA Traffic Situations)",
  "tunnel": {
    "status": "congested",
    "closureReason": null,
    "north": { "queueKm": 4.0, "waitMinutes": 40, "cause": "Hohes Verkehrsaufkommen", "closures": [] },
    "south": { "queueKm": null, "waitMinutes": null, "cause": null, "closures": [] },
    "plannedClosures": []
  },
  "pass": { "status": "closed", "note": null }
}
```

`/api/history.php` returns points such as
`{"t":"2026-11-11T09:24:01+00:00","northQueueKm":4,"southQueueKm":null,"northWaitMinutes":40,"southWaitMinutes":null,"status":"congested"}`.

Languages live at real URLs (`/`, `/en`), not `?lang=`. Free-text fields from
the feed (`cause`, pass `note`) are shown in the feed's language and are not
translated.

## Known limitations

- Forecast and statistics data are generated offline from a scraped
  third-party dataset that is not in the repository, see
  [docs/data-pipeline.md](docs/data-pipeline.md).
- No licence file yet (owner decision pending); data attributions: traffic
  data from ASTRA / opentransportdata.swiss, pass status cross-check from
  alpen-paesse.ch.
- See the open GitHub issues for further work.
