#!/usr/bin/env node
/**
 * Fetches historical daily traffic data from gotthard-traffic.ch.
 *
 * SETUP (one time):
 *   1. Start Chrome with remote debugging:
 *        "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\chrome-debug"
 *   2. In that Chrome window go to: https://www.gotthard-traffic.ch/forecasts
 *   3. Complete the Turnstile challenge if it appears.
 *   4. Run this script: npm run fetch:history
 *
 * The script connects to your real Chrome session (no bot detection),
 * fetches Jun 1 – Sep 30 for 2023/2024/2025, and saves yearly-traffic.json.
 * Commit that file — you never need to run this again.
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir    = dirname(fileURLToPath(import.meta.url));
const dataDir  = join(__dir, '../public/data');
const CDP_URL  = 'http://localhost:9222';
const BASE_URL = 'https://www.gotthard-traffic.ch';
const YEARS    = [2023, 2024, 2025];
const RANGE_START = { month: 6, day: 1 };
const RANGE_END   = { month: 9, day: 30 };
const DELAY_MS    = 200;

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad2(n) { return String(n).padStart(2, '0'); }

function getDatesInRange(year) {
  const dates = [];
  const start = new Date(Date.UTC(year, RANGE_START.month - 1, RANGE_START.day));
  const end   = new Date(Date.UTC(year, RANGE_END.month - 1,   RANGE_END.day));
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1))
    dates.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
  return dates;
}

// ─── Parser ───────────────────────────────────────────────────────────────────

let firstLogDone = false;

function parseDay(json) {
  if (!json || json.success === false) return null;

  if (!firstLogDone) {
    console.log('\n=== First API response ===');
    console.log(JSON.stringify(json, null, 2).slice(0, 600));
    console.log('=========================\n');
    firstLogDone = true;
  }

  const north = json.north ?? json.Nord ?? json.nordportal ?? json.N ?? {};
  const south = json.south ?? json.Sued ?? json.suedportal ?? json.S ?? {};
  const get = (o, ...keys) => { for (const k of keys) if (o[k] != null) return o[k]; return null; };

  const northMin = get(north, 'waitMinutes', 'wait_minutes', 'minutes', 'wartezeit', 'delay');
  const southMin = get(south, 'waitMinutes', 'wait_minutes', 'minutes', 'wartezeit', 'delay');
  const northKm  = get(north, 'queueKm', 'queue_km', 'km');
  const southKm  = get(south, 'queueKm', 'queue_km', 'km');

  return {
    northMinutes: northMin != null ? Math.round(northMin) : northKm != null ? Math.round(Math.min(50, northKm * 9)) : 0,
    southMinutes: southMin != null ? Math.round(southMin) : southKm != null ? Math.round(Math.min(50, southKm * 9)) : 0,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Connecting to Chrome on localhost:9222 …');
  console.log('(Start Chrome with --remote-debugging-port=9222 if this fails)\n');

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    console.error('Could not connect to Chrome. Start it with:\n');
    console.error('  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%TEMP%\\chrome-debug"\n');
    console.error('Then go to https://www.gotthard-traffic.ch/forecasts, solve the challenge, and re-run.');
    process.exit(1);
  }

  // Use the page the user already has open — do NOT navigate (Cloudflare blocks goto via CDP)
  const contexts = browser.contexts();
  const context  = contexts[0] ?? await browser.newContext();
  let   page     = context.pages()[0] ?? await context.newPage();

  console.log(`Current page: ${page.url()}`);
  console.log('Checking API access …');

  let accessible = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const debug = await page.evaluate(async (url) => {
        const hasTurnstile = !!document.querySelector('.cf-turnstile');
        const title = document.title;
        try {
          const r = await fetch(url);
          const body = await r.text();
          return { hasTurnstile, title, status: r.status, body: body.slice(0, 300) };
        } catch (e) {
          return { hasTurnstile, title, status: 0, body: e.message };
        }
      }, `${BASE_URL}/api/daily_traffic?date=2026-07-06`);

      console.log(`  Page title: "${debug.title}"`);
      console.log(`  Turnstile visible: ${debug.hasTurnstile}`);
      console.log(`  API status: ${debug.status}`);
      console.log(`  API body: ${debug.body}`);

      accessible = debug.status === 200 && !debug.body.includes('"success": false') && !debug.body.includes('"success":false');
      break;
    } catch {
      await new Promise(r => setTimeout(r, 2000));
      page = context.pages()[0] ?? page;
    }
  }

  if (!accessible) {
    console.error('\nAPI not accessible. See diagnostics above.');
    if ((await page.evaluate(() => !!document.querySelector('.cf-turnstile')).catch(() => false))) {
      console.error('The Turnstile challenge is still visible — please solve it in the Chrome window first.');
    }
    await browser.close();
    process.exit(1);
  }

  console.log('API accessible ✓  Starting data fetch …\n');

  // Fetch all dates from inside the live browser session
  const result = { generated: new Date().toISOString(), years: {} };

  for (const year of YEARS) {
    const dates = getDatesInRange(year);
    console.log(`── ${year} (${dates.length} days) ──`);
    result.years[year] = [];
    let ok = 0, skip = 0;

    for (const isoDate of dates) {
      process.stdout.write(`${isoDate.slice(5)} `);

      let json = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          json = await page.evaluate(async (url) => {
            try { const r = await fetch(url); return r.ok ? await r.json() : null; }
            catch { return null; }
          }, `${BASE_URL}/api/daily_traffic?date=${isoDate}`);
          break;
        } catch {
          await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
          page = context.pages()[0] ?? page;
        }
      }

      const parsed = json ? parseDay(json) : null;
      if (!parsed) { process.stdout.write('[?] '); skip++; }
      else {
        result.years[year].push({ date: isoDate, ...parsed });
        process.stdout.write('✓ ');
        ok++;
      }

      await page.waitForTimeout(DELAY_MS);
    }

    console.log(`\n  → ${ok} OK, ${skip} skipped\n`);
  }

  await browser.close();

  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, 'yearly-traffic.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2));

  const total = Object.values(result.years).reduce((s, pts) => s + pts.length, 0);
  const max   = YEARS.length * getDatesInRange(2000).length;
  console.log(`Saved ${outPath}  (${total} / ${max} data points)`);

  if (total > 0)
    console.log('\n✓ Done! Commit public/data/yearly-traffic.json — no need to re-run.');
  else
    console.log('\n[!] 0 points. Update parseDay() if the field names in the response log above differ.');
}

main().catch(err => { console.error('[fatal]', err.message); process.exit(1); });
