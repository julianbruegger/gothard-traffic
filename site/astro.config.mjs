import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { HREFLANG, X_DEFAULT_LANG, ROUTES, alternates, lookupPath } from './src/lib/routes.ts';

const SITE = 'https://gotthard.jubr.app';

// @astrojs/sitemap rewrites the root <loc> to "https://host" (no slash) when
// build.format is 'file', while the page's canonical and every hreflang use
// "https://host/". Put the slash back so sitemap and HTML agree exactly. Runs
// after the sitemap integration (integration hooks run in order).
const sitemapRootSlash = {
  name: 'sitemap-root-slash',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const out = fileURLToPath(dir);
      for (const f of readdirSync(out).filter((n) => /^sitemap-\d+\.xml$/.test(n))) {
        const p = join(out, f);
        writeFileSync(p, readFileSync(p, 'utf8').replaceAll(`<loc>${SITE}</loc>`, `<loc>${SITE}/</loc>`));
      }
    },
  },
};

// Static output only - no server/adapter needed. Build once (locally or in CI),
// then upload the contents of dist/ to any plain HTML/PHP web host.
export default defineConfig({
  output: 'static',
  site: SITE,
  trailingSlash: 'never',
  compressHTML: true,
  build: {
    format: 'file',
  },
  integrations: [
    sitemap({
      // Emit <xhtml:link rel="alternate" hreflang="…"> pairs for every page so
      // Google understands the German (root) and English (/en) versions are the
      // same content in two languages. The integration's own `i18n` option pairs
      // pages by identical path, which breaks for translated slugs
      // (/sperrungen ↔ /en/closures), so the alternates come from the route map
      // (src/lib/routes.ts) — the same source Layout uses for hreflang.
      // No lastmod override: build time would change on every deploy and teach
      // crawlers to ignore the field.
      serialize(item) {
        const route = lookupPath(new URL(item.url).pathname);
        if (!route) return item;
        // Same URL as the page's canonical ("https://…/" for the German home).
        item.url = SITE + ROUTES[route.key][route.lang];
        const links = alternates(route.key).map(([lang, path]) => ({ lang: HREFLANG[lang], url: SITE + path }));
        const xDefault = ROUTES[route.key][X_DEFAULT_LANG];
        if (xDefault) links.push({ lang: 'x-default', url: SITE + xDefault });
        item.links = links;
        return item;
      },
    }),
    sitemapRootSlash,
  ],
});
