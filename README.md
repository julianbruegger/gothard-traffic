# Gotthard Traffic Live

An independent clone of the gotthard-traffic.ch idea: live queue length, waiting
time and road status for the Gotthard road tunnel (north/south portal) and the
Gotthard Pass, built for **plain HTML/PHP web hosting with no Node.js at
runtime**.

## How it works

```
                 ┌─────────────────────────┐
   npm run build │  Astro (site/)          │  → dist/index.html, /_astro/*,
   (Node, local  │  static output only     │    robots.txt, sitemap.xml, ...
   or in CI)     └─────────────────────────┘
                              │  upload once (or via CI)
                              ▼
   ┌───────────────────────────────────────────────────────────┐
   │  Your PHP web host (no Node needed here at all)           │
   │                                                            │
   │  index.php  ──reads──▶ index.html (template) + data/*.json│
   │      │                                                     │
   │      └─ injects live status into <title>, meta tags,      │
   │         JSON-LD and the visible numbers before sending    │
   │         HTML to the browser (crawlers/AI bots see live    │
   │         data even without running JavaScript)             │
   │                                                            │
   │  cron/fetch-traffic.php  ──runs every 5–15 min via cron──▶ │
   │      calls the official ASTRA / opentransportdata.swiss   │
   │      traffic feed, writes data/gotthard.json + history.json│
   │                                                            │
   │  Browser JS (bundled into dist/) polls data/*.json every  │
   │  60s and updates the page live without a reload.          │
   └───────────────────────────────────────────────────────────┘
```

Node/npm is **only** needed to run `astro build` (on your laptop, or in the
included GitHub Actions workflow). The web host only ever needs PHP + cron.

## Repository layout

- `site/` – the Astro project (frontend). `npm run build` produces `site/dist/`.
- `server/index.php` – reads `dist/index.html` as a template and injects live
  data server-side (SEO/AI-crawler support). Deployed to the web root.
- `server/lib/` – PHP helpers shared by `index.php` (i18n, formatting, the SSR
  injection logic).
- `server/cron/fetch-traffic.php` – the scraper, invoked by a cron job. Writes
  `data/gotthard.json` and `data/history.json`.
- `server/translations.json` – a build-time copy of `site/src/data/translations.json`
  kept in sync by the deploy workflow (single source of truth is the Astro copy).
- `.github/workflows/deploy.yml` – builds the site and deploys it via rsync over SSH (gated by `ci.yml`).

## 1. Get an ASTRA / opentransportdata.swiss API token

Traffic data comes from the official Swiss open data platform, not from
scraping another traffic site's HTML.

1. Register at https://api-manager.opentransportdata.swiss/
2. Subscribe to the "Traffic Situations" (road traffic) product.
3. Copy `server/cron/config.example.php` to `server/cron/config.php` and set
   `api_token` (and `auth_header`/`auth_prefix` if the portal shows you a
   `Ocp-Apim-Subscription-Key` header instead of a Bearer token).

`config.php` is gitignored - never commit real credentials.

**Note on the DATEX II parsing:** this project was built without a live API
token to test against, so `TrafficParser.php` matches records by keyword
search (case-insensitive "gotthard", "göschenen", "airolo", ...) and
namespace-agnostic field names (`local-name()` XPath) rather than a strict
schema. Once you have a real token, run:

```
php server/cron/fetch-traffic.php --debug
```

This prints every matched raw XML record. If `queueKm`/`waitMinutes` come back
empty, inspect the dumped XML and adjust the field names in
`extractQueueKm()` / `extractWaitMinutes()` in `TrafficParser.php`. A test
fixture + assertions are in `server/cron/tests/` (`php server/cron/tests/test-parser.php`).

## 2. Local development

```bash
cd site
npm install
npm run dev       # http://localhost:4321, uses sample data in public/data/
npm run build     # produces site/dist/
```

The dashboard reads `/data/gotthard.json` and `/data/history.json` at
runtime via `fetch()`. `site/public/data/*.json` contains sample data so the
UI looks realistic in local dev; those files are deliberately **not**
deployed (see below) so they never overwrite the real, cron-maintained data
on your host.

To test the PHP layer locally:

```bash
cd server/cron
cp config.example.php config.php   # fill in your API token
php fetch-traffic.php --debug
```

## 3. Deploy to your PHP host

### Directory layout on the host (web root)

```
/ (web root)
├── index.php          ← from server/index.php
├── index.html          ← from site/dist/ (Astro build output)
├── _astro/...          ← from site/dist/
├── robots.txt, sitemap.xml, llms.txt, favicon.svg, og-image.png  ← from site/dist/
├── lib/                ← from server/lib/ (HTTP access denied)
├── translations.json   ← copy of site/src/data/translations.json
├── cron/
│   ├── fetch-traffic.php
│   ├── migrate.php, schema.sql
│   ├── lib/
│   └── config.php       ← you create this on the server, never commit it
└── data/                ← cron-written; only .htaccess (deny all) is deployed
    ├── gotthard.json
    └── history.json
```

### Option A: manual upload

1. `cd site && npm run build`
2. Upload the contents of `site/dist/` to your web root, **except**
   `dist/data/` (that's sample data for local dev only).
3. Upload `server/index.php` and `server/lib/` to the web root.
4. Upload `server/cron/` (minus `server/cron/tests/`) to `webroot/cron/`.
5. Copy `site/src/data/translations.json` to `webroot/translations.json`.
6. On the server, copy `cron/config.example.php` to `cron/config.php` and add
   your API token.
7. Set up a cron job (cPanel → Cron Jobs, every 10-15 minutes):
   ```
   */10 * * * * php /home/yourusername/public_html/cron/fetch-traffic.php >> /home/yourusername/public_html/cron/cron.log 2>&1
   ```

### Option B: GitHub Actions (automatic on push)

`.github/workflows/ci.yml` runs on every pull request and push to `main`: PHP
lint, the PHP test scripts in `server/cron/tests/`, and `npm ci` +
`npm run build` (Astro check and build) in `site/`.

`.github/workflows/deploy.yml` runs on pushes to `main`, only after CI passes.
It builds the site, assembles the bundle, rsyncs it over SSH (environment
**Hostpoint**), runs `php cron/migrate.php` on the server (creates tables and
applies idempotent column additions) and finally smoke-tests the live site
(`/`, `/en`, `/forecasts`, `/api/gotthard.php` not older than 30 minutes,
`data/` and `schema.sql` not public). Set the repository variable `SITE_URL`
to override the default `https://gotthard.jubr.app`.

Secrets (environment **Hostpoint**): `DATEX_API_TOKEN`, `DB_HOST`, `DB_NAME`,
`DB_USER`, `DB_PASS`, `HOSTPOINT_HOST`, `HOSTPOINT_USER`, `HOSTPOINT_SSH_KEY`,
`HOSTPOINT_PATH` and `HOSTPOINT_KNOWN_HOSTS`.

#### SSH host key pinning (`HOSTPOINT_KNOWN_HOSTS`)

The deploy refuses unknown hosts, so the server's host key must be stored as a
secret. Obtain it once from a network you trust and verify the fingerprint
against your hosting panel:

```
ssh-keyscan -H your.host.example          # value for HOSTPOINT_KNOWN_HOSTS
ssh-keygen -lf <(ssh-keyscan your.host.example 2>/dev/null)   # fingerprint to compare
```

Paste the full `ssh-keyscan` output (one line per key type) as the secret.
If the host key legitimately changes, update the secret.

The workflow only syncs `data/.htaccess` into `data/` and never touches the
files cron writes there, nor `cron/config.php` (generated from secrets on each
deploy). `data/`, `lib/` and `cron/` are denied over HTTP. You still need to
set up the cron job once, manually (step 7 from Option A).

## Notes & limitations

- **Language switching** (`?lang=de` / `?lang=en`) is fully server-rendered by
  `index.php`, including `<title>`, meta tags and JSON-LD. If you ever host
  the raw static `dist/` output without PHP, the page only exists in German
  (the build default) - client-side JS does not re-translate static UI
  strings, by design, to avoid duplicating the i18n logic.
- Free-text fields straight from the traffic feed (the `cause`/`note` you see
  under a queue, or the pass status note) are shown in whatever language the
  upstream ASTRA feed returns them in - they are not machine-translated.
- This is an independent, unofficial project, not affiliated with ASTRA or
  any Swiss authority. Don't rely on it for safety-critical routing decisions.
