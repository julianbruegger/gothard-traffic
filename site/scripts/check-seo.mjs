// Post-build SEO check: node scripts/check-seo.mjs (run after `npm run build`).
// Asserts, for every built page in dist/:
//  - title (≤ 70 chars) and meta description (110–175 chars), unique per language
//  - exactly one <h1>
//  - every JSON-LD block parses
//  - canonical is absolute, on this site, and listed among its own hreflang alternates
//  - hreflang reciprocity: every alternate page exists and links back with the same set
//  - every same-site link (href/src) resolves to a built file or a server/api/ script
// and site-wide:
//  - every sitemap <loc> equals the canonical of its page, the sitemap's hreflang
//    set equals the page's <link rel="alternate"> set, and every page is listed
//  - every same-site URL in public/llms.txt exists
//  - nothing references Google Fonts
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const apiDir = join(root, '..', 'server', 'api');
const ORIGIN = 'https://gotthard.jubr.app';
const TITLE_MAX = 70;
const errors = [];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();

/** Built file for a same-site path ("/", "/en", "/forecasts", "/api/x.php", "/_astro/…"). */
function resolvePath(path) {
  const clean = decodeURIComponent(path.split('#')[0].split('?')[0]) || '/';
  if (clean === '/') return isFile(join(dist, 'index.html')) ? join(dist, 'index.html') : null;
  const p = clean.replace(/\/+$/, '');
  const candidates = [join(dist, p), join(dist, p + '.html'), join(dist, p, 'index.html')];
  if (p.startsWith('/api/')) candidates.push(join(apiDir, p.slice('/api/'.length)));
  return candidates.find(isFile) ?? null;
}

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

// ── Per page ──────────────────────────────────────────────────────────────
const pages = new Map(); // dist file → { rel, canonical, alternates: Map(hreflang → href) }
const seen = {};
const htmlFiles = walk(dist).filter((f) => f.endsWith('.html'));

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const rel = file.slice(dist.length);
  const lang = /<html[^>]*lang="([\w-]+)"/.exec(html)?.[1] ?? 'de';
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1]?.trim();
  // Lengths as a reader sees them (entities like &amp; count as one character).
  const text = (s) => s?.replace(/&(amp|lt|gt|quot|#39);/g, '_');
  if (!title || text(title).length > TITLE_MAX) errors.push(`${rel}: bad title length (${text(title)?.length}, max ${TITLE_MAX})`);
  if (!desc || text(desc).length < 110 || text(desc).length > 175) errors.push(`${rel}: bad description length (${text(desc)?.length})`);
  seen[lang] ??= { title: new Map(), desc: new Map() };
  for (const [kind, val] of [['title', title], ['desc', desc]]) {
    if (!val) continue;
    const m = seen[lang][kind];
    if (m.has(val)) errors.push(`${rel}: duplicate ${kind} (also ${m.get(val)})`);
    else m.set(val, rel);
  }

  // Ids must be unique per page (SSR and live.ts address elements by id).
  const ids = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    if (ids.has(m[1])) errors.push(`${rel}: duplicate id "${m[1]}"`);
    ids.add(m[1]);
  }

  const h1s = html.match(/<h1[\s>]/g)?.length ?? 0;
  if (h1s !== 1) errors.push(`${rel}: ${h1s} <h1> elements (expected exactly 1)`);

  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const ld = JSON.parse(m[1]);
      if (!ld['@context']) errors.push(`${rel}: JSON-LD block without @context`);
    } catch (e) {
      errors.push(`${rel}: JSON-LD does not parse (${e.message})`);
    }
  }

  const canonical = html.match(/<link[^>]*rel="canonical"[^>]*>/)?.[0];
  const canonicalHref = canonical && attr(canonical, 'href');
  if (!canonicalHref?.startsWith(ORIGIN)) errors.push(`${rel}: missing or foreign canonical (${canonicalHref})`);
  const alternates = new Map();
  for (const tag of html.match(/<link[^>]*rel="alternate"[^>]*hreflang=[^>]*>/g) ?? []) {
    const hl = attr(tag, 'hreflang');
    if (alternates.has(hl)) errors.push(`${rel}: hreflang "${hl}" listed twice`);
    alternates.set(hl, attr(tag, 'href'));
  }
  if (alternates.size && ![...alternates].some(([hl, href]) => hl !== 'x-default' && href === canonicalHref)) {
    errors.push(`${rel}: canonical ${canonicalHref} is not among its hreflang alternates`);
  }
  pages.set(file, { rel, canonical: canonicalHref, alternates });

  // Every same-site link must resolve to something we deploy.
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1].replace(/&amp;/g, '&');
    let path;
    if (url.startsWith(ORIGIN)) path = url.slice(ORIGIN.length) || '/';
    else if (url.startsWith('/') && !url.startsWith('//')) path = url;
    else continue;
    if (!resolvePath(path)) errors.push(`${rel}: broken internal link ${url}`);
  }
}

// ── hreflang reciprocity ─────────────────────────────────────────────────
const byCanonical = new Map([...pages.values()].map((p) => [p.canonical, p]));
const setKey = (m) => [...m].map(([k, v]) => `${k}=${v}`).sort().join(' ');
for (const page of pages.values()) {
  for (const [hl, href] of page.alternates) {
    const target = byCanonical.get(href);
    if (!target) {
      errors.push(`${page.rel}: hreflang ${hl} → ${href} is not the canonical of any built page`);
      continue;
    }
    if (setKey(target.alternates) !== setKey(page.alternates)) {
      errors.push(`${page.rel}: hreflang set differs from ${target.rel} (alternates must point back to each other)`);
    }
  }
}

// ── Sitemap ↔ pages ──────────────────────────────────────────────────────
const sitemapFiles = readdirSync(dist).filter((f) => /^sitemap-\d+\.xml$/.test(f));
if (!sitemapFiles.length) errors.push('sitemap: no sitemap-N.xml in dist');
const listed = new Set();
for (const f of sitemapFiles) {
  const xml = readFileSync(join(dist, f), 'utf8');
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const loc = /<loc>([^<]*)<\/loc>/.exec(m[1])?.[1];
    const page = byCanonical.get(loc);
    if (!page) {
      errors.push(`sitemap: <loc>${loc}</loc> is not the canonical of any built page`);
      continue;
    }
    listed.add(page.rel);
    const links = new Map();
    for (const l of m[1].match(/<xhtml:link[^>]*>/g) ?? []) links.set(attr(l, 'hreflang'), attr(l, 'href'));
    if (setKey(links) !== setKey(page.alternates)) {
      errors.push(`sitemap: hreflang set for ${loc} differs from the page (sitemap: ${setKey(links)} | page: ${setKey(page.alternates)})`);
    }
  }
}
for (const page of pages.values()) {
  if (!listed.has(page.rel)) errors.push(`sitemap: ${page.rel} (${page.canonical}) is missing`);
}

// ── llms.txt ─────────────────────────────────────────────────────────────
const llms = readFileSync(join(root, 'public', 'llms.txt'), 'utf8');
for (const url of new Set(llms.match(/https:\/\/gotthard\.jubr\.app[^\s)]*/g) ?? [])) {
  const path = url.slice(ORIGIN.length).replace(/[.,]$/, '') || '/';
  if (!resolvePath(path)) errors.push(`llms.txt: ${url} not found`);
}

// No built page/stylesheet may reference a third-party font host (visitors'
// browsers must not contact Google).
for (const file of walk(dist).filter((f) => /\.(html|css|js)$/.test(f))) {
  const body = readFileSync(file, 'utf8');
  if (/fonts\.(googleapis|gstatic)\.com/.test(body)) errors.push(`${file.slice(dist.length)}: references Google Fonts`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`SEO check passed (${pages.size} pages)`);
