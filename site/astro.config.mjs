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
      // same content in two languages. No lastmod override: build time would
      // change on every deploy and teach crawlers to ignore the field.
      i18n: {
        defaultLocale: 'de',
        locales: {
          de: 'de-CH',
          en: 'en',
        },
      },
    }),
  ],
});
