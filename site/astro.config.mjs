import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Static output only - no server/adapter needed. Build once (locally or in CI),
// then upload the contents of dist/ to any plain HTML/PHP web host.
export default defineConfig({
  output: 'static',
  site: 'https://gotthard.jubr.app',
  trailingSlash: 'never',
  compressHTML: true,
  build: {
    format: 'file',
  },
  integrations: [
    sitemap({
      // Emit <xhtml:link rel="alternate" hreflang="…"> pairs for every page so
      // Google understands the German (root) and English (/en) versions are the
      // same content in two languages. lastmod (build time) nudges recrawl of a
      // page whose live data changes constantly.
      i18n: {
        defaultLocale: 'de',
        locales: {
          de: 'de-CH',
          en: 'en',
        },
      },
      serialize(item) {
        item.lastmod = new Date().toISOString();
        return item;
      },
    }),
  ],
});
