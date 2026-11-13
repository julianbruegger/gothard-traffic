// Build-time forecast per day -> dist/forecast-days.json.
//
// The PHP host runs no Node, so the forecast model (forecast.ts with the bundled
// observed-days.json, empirical-profiles.json and the holiday calendar) is
// evaluated here once per build for the next FORECAST_DAYS days.
// server/lib/ForecastTable.php reads the file and renders the forecast table for
// the current Swiss day into the <!--SSR:forecast-week--> and
// <!--SSR:forecast-range:…--> markers, so crawlers get it as plain HTML.
//
// Schema:
//   generated   ISO timestamp of the build
//   timezone    "Europe/Zurich" (dates are Swiss-local calendar days)
//   method      short description of the model
//   directions  what "north"/"south" mean (portal of the queue, NOT travel direction)
//   quietMin    peaks below this many minutes count as "no relevant queue"
//   days[]      { date, north: { peakMin, peakHour, peakKm, busyMin }, south: {…}, holiday: { de, en } | null }
import type { APIRoute } from 'astro';
import { FORECAST_DAYS, QUIET_PEAK_MIN, forecastDaySummaries } from '../lib/forecast-days';

export const GET: APIRoute = () => {
  const now = new Date();
  const body = {
    generated: now.toISOString(),
    timezone: 'Europe/Zurich',
    method: 'Calendar forecast: hourly profiles fitted to our own ASTRA readings at the tunnel, seasonal and holiday effects from TCS jam reports 2016-2026; waiting time ≈ 10 min per km of queue.',
    directions: {
      north: 'Queue at the north portal Göschenen = traffic heading south (towards Italy)',
      south: 'Queue at the south portal Airolo = traffic heading north (towards northern Switzerland)',
    },
    quietMin: QUIET_PEAK_MIN,
    days: forecastDaySummaries(now, FORECAST_DAYS),
  };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
