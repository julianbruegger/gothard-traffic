#!/usr/bin/env node
/**
 * Fetches live Gotthard traffic data from opentransportdata.swiss (DATEX II)
 * and writes public/data/gotthard.json + public/data/history.json.
 *
 * Usage:
 *   node scripts/fetch-data.mjs           # fetch once
 *   node scripts/fetch-data.mjs --watch   # fetch every 60s
 *
 * Requires DATEX_API_TOKEN as an env var or in site/.env:
 *   DATEX_API_TOKEN=your_token_here
 *
 * Get a free token at https://api-manager.opentransportdata.swiss/
 * (register → subscribe to "Traffic Situations" / road traffic product).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dir, '../public/data');

const API_URL =
  'https://api.opentransportdata.swiss/TDP/Soap_Datex2/TrafficSituations/Pull';

// Specific portal/tunnel identifiers — always relevant.
const TUNNEL_KEYWORDS = [
  'göschenen', 'goeschenen', 'airolo',
  'gotthard-tunnel', 'gotthard tunnel', 'gotthard strassentunnel',
  'nordportal', 'südportal', 'north portal', 'south portal',
];
// "gotthard" alone as a route direction is too broad for non-jam records
// (construction records also say "A2 Luzern -> Gotthard"). Only use it for
// Stau records, and only when traffic is heading TOWARDS the tunnel
// ("-> gotthard"), not away from it ("gotthard ->").
function isTunnelApproachJam(record) {
  if (!/\bstau\b|\bbouchon\b|\bcolonna\b/i.test(record)) return false;
  const lower = record.toLowerCase();
  // "->" is HTML-encoded as "-&gt;" in the raw DATEX II XML.
  return lower.includes('-&gt; gotthard') || lower.includes('-> gotthard') || lower.includes('→ gotthard');
}
// "passstrasse" alone matches junction names like "Anschluss Passstrasse" on
// the A13 San Bernardino. Keep only the unambiguous Gotthard pass identifiers.
// The feed uses "Gotthard-Pass" (with hyphen) so include both forms.
const PASS_KEYWORDS = ['gotthardpass', 'gotthard-pass', 'passo del gottardo', 'gotthard pass'];
const POLL_MS = 60_000;
const HISTORY_RETENTION_HOURS = 48;
const HISTORY_MIN_INTERVAL_MINUTES = 10;

// ---------------------------------------------------------------------------
// Token loading
// ---------------------------------------------------------------------------

function loadToken() {
  if (process.env.DATEX_API_TOKEN) return process.env.DATEX_API_TOKEN.trim();
  const envPath = join(__dir, '../.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf8');
    const m = content.match(/^DATEX_API_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  }
  return '';
}

// ---------------------------------------------------------------------------
// XML helpers (namespace-agnostic — matches both `<tag>` and `<ns:tag>`)
// ---------------------------------------------------------------------------

/** Regex fragment that matches an element with the given local name. */
function tagRe(localName) {
  const o = `<(?:[a-zA-Z_][\\w.-]*:)?${localName}(?:\\s[^>]*)?>`;
  const c = `<\\/(?:[a-zA-Z_][\\w.-]*:)?${localName}>`;
  return { open: o, close: c };
}

/** Extract all `situationRecord` element strings from raw XML. */
function extractRecords(xml) {
  const { open, close } = tagRe('situationRecord');
  const re = new RegExp(`${open}[\\s\\S]*?${close}`, 'gi');
  return xml.match(re) ?? [];
}

/** Get first text value inside a named element within a block of XML. */
function getText(xml, localName) {
  const { open, close } = tagRe(localName);
  const re = new RegExp(`${open}([\\s\\S]*?)${close}`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  // Strip any child tags to get bare text
  const text = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
}

const CAUSE_TYPE_MAP = {
  shearWeightOfTraffic: 'Hohes Verkehrsaufkommen',
  heavyTraffic: 'Starker Verkehr',
  accident: 'Unfall',
  vehicleBreakdown: 'Pannenfahrzeug',
  roadworks: 'Baustelle',
  obstruction: 'Hindernis',
  poorVisibility: 'Schlechte Sicht',
  ice: 'Glatteis',
  snow: 'Schnee',
  flooding: 'Überschwemmung',
};

/** Short cause string: DATEX II causeType → German label, else "Ursache: X" from comment. */
function extractCause(record) {
  const ctRaw = getText(record, 'causeType');
  if (ctRaw) {
    const key = ctRaw.trim();
    return CAUSE_TYPE_MAP[key] ?? key;
  }
  // Fall back: extract just "Ursache: X" from the free-text comment
  const m = record.match(/ursache[:\s]+([^,\n<]{2,80})/i);
  if (m) {
    const raw = decodeXmlEntities(m[1].trim());
    return raw.replace(/\s+zusatz.*/i, '').replace(/\s+verkehrsführung.*/i, '').trim().slice(0, 60) || null;
  }
  return null;
}

function decodeXmlEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/** Get the first human-readable comment string from a generalPublicComment block. */
function getFirstValue(record) {
  // Only look inside generalPublicComment/nonGeneralPublicComment blocks,
  // not bare <value> elements that belong to structured enumerations.
  const commentBlock = record.match(
    /<[^>]*(?:generalPublicComment|nonGeneralPublicComment|comment)[^>]*>[\s\S]*?<\/[^>]*(?:generalPublicComment|nonGeneralPublicComment|comment)>/i
  );
  if (!commentBlock) return null;
  const { open, close } = tagRe('value');
  const re = new RegExp(`${open}([^<]{5,})${close}`, 'i');
  const m = commentBlock[0].match(re);
  return m ? decodeXmlEntities(m[1].trim()).slice(0, 200) : null;
}

function containsAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((k) => k && lower.includes(k));
}

/** [from, to] epoch-ms window of a closure: structured times, else German "…bis…" text. */
function extractClosureWindow(record) {
  const decoded = decodeXmlEntities(record);
  const start = getText(record, 'startOfPeriod') ?? getText(record, 'overallStartTime');
  const end = getText(record, 'endOfPeriod') ?? getText(record, 'overallEndTime');
  let from = start ? Date.parse(start) : null;
  let to = end ? Date.parse(end) : null;
  if ((from === null || Number.isNaN(from)) && (to === null || Number.isNaN(to))) {
    const m = decoded.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})\s+bis\s+(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/);
    if (m) {
      from = Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:00`);
      to = Date.parse(`${m[8]}-${m[7]}-${m[6]}T${m[9]}:${m[10]}:00`);
    }
  }
  if (from === null || Number.isNaN(from)) from = null;
  if (to === null || Number.isNaN(to)) to = null;
  return { from, to };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseXml(xml) {
  const records = extractRecords(xml);

  let northKm = 0, northMin = 0, northCause = null, northClosures = [];
  let southKm = 0, southMin = 0, southCause = null, southClosures = [];
  let pass = { status: 'unknown', note: null };
  let tunnelClosed = false;
  let plannedClosures = [];

  for (const record of records) {
    const text = record.toLowerCase();
    const isPass = containsAny(text, PASS_KEYWORDS);
    const isTunnel = containsAny(text, TUNNEL_KEYWORDS);

    if (!isPass && !isTunnel && !isTunnelApproachJam(record)) continue;


if (isPass) {
      if (containsAny(text, ['gesperrt', 'geschlossen', 'closed', 'wintersperre'])) {
        pass.status = 'closed';
      } else if (containsAny(text, ['eingeschränkt', 'restricted', 'einspurig', 'wechselseitig', 'fahrbahnverengung', 'baustelle', 'lichtsignalanlage'])) {
        pass.status = 'restricted';
      } else if (pass.status === 'unknown') {
        pass.status = 'open';
      }
      pass.note = getFirstValue(record) ?? pass.note;
      continue;
    }

    // "Aufgehoben" = lifted/revoked — the situation no longer applies.
    if (text.includes('aufgehoben')) continue;

    // Whole tunnel bore closure (Göschenen ↔ Airolo). Handle its timing here so
    // a future closure is surfaced as a planned event, not shown as "closed now".
    const isBoreClosure =
      /tunnel gesperrt/i.test(text) && text.includes('göschenen') && text.includes('airolo');
    if (isBoreClosure) {
      const { from, to } = extractClosureWindow(record);
      const nowMs = Date.now();
      const active = (from === null || from <= nowMs) && (to === null || to >= nowMs);
      if (active) {
        tunnelClosed = true;
      } else if (from !== null && from > nowMs) {
        plannedClosures.push({
          from: new Date(from).toISOString(),
          to: to !== null ? new Date(to).toISOString() : null,
          cause: extractCause(record),
        });
      }
      continue;
    }

    // Jam and entry-closure records that haven't been updated in >3 hours are stale.
    // Construction records are long-lived and exempt from this check.
    const isJamRecord = /\bstau\b|\bbouchon\b|\bcolonna\b/i.test(record);
    const isEntryGesperrt = /einfahrt\s+gesperrt|einfahrt\s+closed|entr[eé]e\s+ferm[eé]e/i.test(record);
    if (isJamRecord || isEntryGesperrt) {
      const versionMatch = record.match(/<[^>]*situationRecordVersionTime[^>]*>([^<]+)<\/[^>]*situationRecordVersionTime>/i);
      if (versionMatch) {
        const age = Date.now() - Date.parse(versionMatch[1].trim());
        if (age > 3 * 3600_000) continue; // older than 3 hours → stale
      }
    }

    const isSouth =
      text.includes('airolo') ||
      text.includes('südportal') ||
      text.includes('south portal');

    // Entry closure dosage records (no queue data, but status worth showing).
    if (isEntryGesperrt) {
      const decoded = decodeXmlEntities(record);
      const jm = decoded.match(/Anschluss\s+([A-Za-zÀ-ɏ][A-Za-zÀ-ɏ\-]*)/i);
      const label = jm ? jm[1] : null;
      const closure = label ? `Einfahrt ${label} gesperrt` : 'Einfahrt gesperrt';
      if (isSouth) { if (!southClosures.includes(closure)) southClosures.push(closure); }
      else { if (!northClosures.includes(closure)) northClosures.push(closure); }
    }

    // Queue length — try XML element first, then ASTRA text formats.
    // ASTRA embeds queue as "Länge [km] 1.0" (number AFTER the unit label),
    // not as a bare "1.0 km" string.
    let queueKm = null;
    const qlRaw = getText(record, 'queueLength') ?? getText(record, 'length');
    if (qlRaw) {
      const meters = parseFloat(qlRaw);
      if (meters > 0) queueKm = Math.round(meters / 100) / 10;
    }
    // Only extract [km] values from jam records ("Stau"/"bouchon"/"colonna").
    // Construction records ("Baustelle") also use "Länge [km] X" for zone
    // length, which is not a traffic queue.
    const isJam = /\bstau\b|\bbouchon\b|\bcolonna\b/i.test(record);
    if (isJam && queueKm === null) {
      // "Stau Länge [km] 1.0" / "bouchon longueur [km] 1.0"
      const bracketKm = record.match(/\[km\]\s*(\d+(?:[.,]\d+)?)/i);
      if (bracketKm) queueKm = parseFloat(bracketKm[1].replace(',', '.'));
    }
    if (queueKm === null) {
      // Fallback: bare "1.0 km" anywhere in the text
      const inlineKm = record.match(/(\d+(?:[.,]\d+)?)\s?km\b/ui);
      if (inlineKm) queueKm = parseFloat(inlineKm[1].replace(',', '.'));
    }

    // Wait time — try XML element first, then ASTRA text format.
    // ASTRA embeds delay as "Zeitverlust Anz. [min] 10".
    let waitMinutes = null;
    const delayRaw =
      getText(record, 'delayTimeValue') ??
      getText(record, 'delay') ??
      getText(record, 'estimatedDurationOfDelay');
    if (delayRaw) {
      const seconds = parseFloat(delayRaw);
      if (seconds > 0) waitMinutes = Math.round(seconds / 60);
    }
    if (waitMinutes === null) {
      // "Zeitverlust Anz. [min] 10" / "retards Nbre. [min] 10"
      const bracketMin = record.match(/\[min\]\s*(\d+)/i);
      if (bracketMin) waitMinutes = parseInt(bracketMin[1], 10);
    }
    if (waitMinutes === null) {
      const inlineMin = record.match(/(\d+)\s?(?:minuten|minutes|min)\b/ui);
      if (inlineMin) waitMinutes = parseInt(inlineMin[1], 10);
    }

    const cause = extractCause(record);

    if (DEBUG && queueKm !== null) {
      const dir = isSouth ? 'south' : 'north';
      const snippet = record.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      console.log(`  [${dir}] +${queueKm} km, +${waitMinutes ?? 0} min | ${snippet}`);
    }

    // Sum all jam segments per direction (adjacent sections add up to total queue).
    if (isSouth) {
      southKm = Math.round((southKm + (queueKm ?? 0)) * 10) / 10;
      southMin += waitMinutes ?? 0;
      if (cause && !southCause) southCause = cause;
    } else {
      northKm = Math.round((northKm + (queueKm ?? 0)) * 10) / 10;
      northMin += waitMinutes ?? 0;
      if (cause && !northCause) northCause = cause;
    }
  }

  const north = { queueKm: northKm || null, waitMinutes: northMin || null, cause: northCause, closures: northClosures };
  const south = { queueKm: southKm || null, waitMinutes: southMin || null, cause: southCause, closures: southClosures };

  const status = tunnelClosed
    ? 'closed'
    : northKm > 0 || southKm > 0
    ? 'congested'
    : 'open';

  return { tunnel: { status, north, south, plannedClosures }, pass };
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

function updateHistory(point) {
  const path = join(dataDir, 'history.json');
  let history = [];
  if (existsSync(path)) {
    try {
      history = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      history = [];
    }
  }

  const last = history.at(-1);
  if (last?.t) {
    const minutesSinceLast = (Date.parse(point.t) - Date.parse(last.t)) / 60_000;
    if (minutesSinceLast < HISTORY_MIN_INTERVAL_MINUTES) return;
  }

  history.push(point);

  const cutoff = Date.now() - HISTORY_RETENTION_HOURS * 3600_000;
  history = history.filter((p) => p.t && Date.parse(p.t) >= cutoff);

  writeFileSync(path, JSON.stringify(history, null, 2));
}

// ---------------------------------------------------------------------------
// Main fetch cycle
// ---------------------------------------------------------------------------

const SOAP_ACTION =
  'http://opentransportdata.swiss/TDP/Soap_Datex2/Pull/v1/pullTrafficMessages';

const SOAP_BODY = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <d2LogicalModel modelBaseVersion="2"
      xmlns="http://datex2.eu/schema/2/2_0"
      xmlns:xsd="http://www.w3.org/2001/XMLSchema"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
      <exchange>
        <supplierIdentification>
          <country>ch</country>
          <nationalIdentifier>FEDRO</nationalIdentifier>
        </supplierIdentification>
        <subscription>
          <operatingMode>operatingMode1</operatingMode>
          <subscriptionStartTime>2020-01-01T00:00:00.00+01:00</subscriptionStartTime>
          <subscriptionState>active</subscriptionState>
          <updateMethod>singleElementUpdate</updateMethod>
          <target>
            <address></address>
            <protocol>http</protocol>
          </target>
        </subscription>
      </exchange>
    </d2LogicalModel>
  </soap:Body>
</soap:Envelope>`;

const DEBUG = process.argv.includes('--debug');

async function fetchAndWrite(token) {
  const now = new Date().toISOString();
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'text/xml; charset=UTF-8',
        Accept: 'text/xml, application/xml',
        SOAPAction: SOAP_ACTION,
      },
      body: SOAP_BODY,
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 300);
      throw new Error(`HTTP ${res.status}: ${snippet}`);
    }

    const xml = await res.text();
    const result = parseXml(xml);

    const output = {
      updated: now,
      source: 'opentransportdata.swiss (ASTRA Traffic Situations)',
      ...result,
    };

    writeFileSync(join(dataDir, 'gotthard.json'), JSON.stringify(output, null, 2));

    updateHistory({
      t: now,
      northQueueKm: result.tunnel.north.queueKm ?? 0,
      southQueueKm: result.tunnel.south.queueKm ?? 0,
      northWaitMinutes: result.tunnel.north.waitMinutes ?? 0,
      southWaitMinutes: result.tunnel.south.waitMinutes ?? 0,
    });

    console.log(`[${now}] OK — north ${result.tunnel.north.queueKm ?? 0} km, south ${result.tunnel.south.queueKm ?? 0} km`);
  } catch (err) {
    console.error(`[${now}] fetch-data failed: ${err.message}`);
    if (!process.argv.includes('--watch')) process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const token = loadToken();
if (!token) {
  console.error(
    'Error: DATEX_API_TOKEN not set.\n' +
    'Create site/.env with:\n' +
    '  DATEX_API_TOKEN=your_token_here\n\n' +
    'Get a free token at https://api-manager.opentransportdata.swiss/'
  );
  process.exit(1);
}

await fetchAndWrite(token);

if (process.argv.includes('--watch')) {
  console.log(`Watching: refetching every ${POLL_MS / 1000}s (Ctrl+C to stop)`);
  setInterval(() => fetchAndWrite(token), POLL_MS);
}
