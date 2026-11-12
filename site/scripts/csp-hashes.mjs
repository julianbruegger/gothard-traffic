// Post-build step: node scripts/csp-hashes.mjs (runs after `astro build`).
// Computes the SHA-256 of every inline executable <script> in dist/**/*.html and
// writes them into the Content-Security-Policy in dist/.htaccess (replacing the
// __CSP_SCRIPT_HASHES__ placeholder from public/.htaccess). JSON-LD blocks are
// non-executing data and are skipped. Fails the build if dist/.htaccess or the
// placeholder is missing.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const htaccess = join(dist, '.htaccess');
const PLACEHOLDER = '__CSP_SCRIPT_HASHES__';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(htaccess)) {
  console.error('csp-hashes: dist/.htaccess not found (run astro build first)');
  process.exit(1);
}

const hashes = new Set();
for (const file of walk(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1] ?? '';
    const body = m[2];
    if (/\ssrc=/.test(' ' + attrs.trim())) continue; // external file, covered by 'self'
    const type = /\btype="([^"]*)"/.exec(attrs)?.[1] ?? '';
    if (type && type !== 'module' && type !== 'text/javascript') continue; // JSON-LD etc.: not executed
    if (!body.trim()) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
}

const src = readFileSync(htaccess, 'utf8');
if (!src.includes(PLACEHOLDER)) {
  console.error(`csp-hashes: ${PLACEHOLDER} not found in dist/.htaccess`);
  process.exit(1);
}
writeFileSync(htaccess, src.replaceAll(PLACEHOLDER, [...hashes].sort().join(' ')));
console.log(`csp-hashes: ${hashes.size} inline script hash(es) written to dist/.htaccess`);
