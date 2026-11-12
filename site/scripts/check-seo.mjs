// Post-build SEO check: node scripts/check-seo.mjs (run after `npm run build`).
// Asserts per-language unique <title>/meta description within length limits,
// and that every same-site URL listed in public/llms.txt exists in dist/ or server/api/.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const apiDir = join(root, '..', 'server', 'api');
const errors = [];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const seen = { de: { title: new Map(), desc: new Map() }, en: { title: new Map(), desc: new Map() } };
for (const file of walk(dist).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(file, 'utf8');
  const lang = /<html[^>]*lang="(\w+)"/.exec(html)?.[1] ?? 'de';
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1]?.trim();
  const desc = /<meta name="description" content="([^"]*)"/.exec(html)?.[1]?.trim();
  const rel = file.slice(dist.length);
  if (!title || title.length > 80) errors.push(`${rel}: bad title length (${title?.length})`);
  if (!desc || desc.length < 110 || desc.length > 175) errors.push(`${rel}: bad description length (${desc?.length})`);
  for (const [kind, val] of [['title', title], ['desc', desc]]) {
    const m = seen[lang]?.[kind];
    if (!m || !val) continue;
    if (m.has(val)) errors.push(`${rel}: duplicate ${kind} (also ${m.get(val)})`);
    else m.set(val, rel);
  }
}

const llms = readFileSync(join(root, 'public', 'llms.txt'), 'utf8');
const origin = 'https://gotthard.jubr.app';
for (const url of new Set(llms.match(/https:\/\/gotthard\.jubr\.app[^\s)]*/g) ?? [])) {
  const path = url.slice(origin.length).replace(/[.,]$/, '') || '/';
  const candidates = [
    join(dist, path),
    join(dist, path + '.html'),
    join(dist, path, 'index.html'),
    join(dist, path === '/' ? 'index.html' : path),
    join(apiDir, path.replace(/^\/api\//, '')),
  ];
  if (!candidates.some((c) => existsSync(c) && statSync(c).isFile())) errors.push(`llms.txt: ${url} not found`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('SEO check passed');
