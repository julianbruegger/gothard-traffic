# Data pipeline

Files that are committed on purpose, where they come from and how to rebuild
them. Everything else under `site/dist/` and `site/.astro/` is build output.

| File | Source | Rebuild | Refresh |
| --- | --- | --- | --- |
| `site/src/data/translations.json` | hand-written (de/en); copied to `translations.json` on the host by the deploy workflow | edit by hand | when copy changes |
| `site/src/data/empirical-profiles.json` | TCS Gotthard traffic reports (scraped tweet history, 2016 to 2026) | `npm run build:profiles -- <path/to/tcs_gotthard_tweets.json>` in `site/` | rarely; when new history is scraped |
| `site/src/data/historic-days.json` | same tweet history, per-day series for the chart overlay | `npm run build:historic-days -- <path/to/tcs_gotthard_tweets.json>` in `site/` | rarely |
| `site/src/data/observed-days.json` | per-day hourly queue lengths from the `gotthard_snapshots` table (cleaned: stale reports, incident closures) | export the table as CSV from phpMyAdmin, then `npm run build:observed -- <path/to/gotthard_snapshots.csv>` in `site/` | before forecast releases; at runtime `api/observed.php` adds recent days |
| `site/src/data/sample-gotthard.json`, `sample-history.json` | hand-made samples used by the build when no live data is available | edit by hand | never |
| `site/public/data/gotthard.json`, `history.json`, `stats.json` | sample data for local dev without PHP (the browser falls back to it); not deployed | `npm run fetch` in `site/` refreshes the first two (needs `DATEX_API_TOKEN`); `stats.json` is hand-made | optional |

## The tweet history file

`tcs_gotthard_tweets.json` is scraped third-party content and is **not in the
repository** (it is gitignored). Keep it locally and pass its path to the
build scripts, or set `TCS_TWEETS_FILE`. Both derived JSON files stay
committed, so a normal build never needs it. It was removed from the working
tree only; it still exists in git history, and purging it from history
requires a force-push and is the owner's decision.

## Live data

Live data is not a file: `server/cron/fetch-traffic.php` writes one row per
run to the `gotthard_snapshots` table and `server/api/*.php` reads from it.
`api/stats.php` (Nerd Mode) and `api/observed.php` (forecast) aggregate it on
demand and cache the result under `data/`. `server/cron/export-history.php` can aggregate the table into weekday x hour
profiles for offline forecast work.
