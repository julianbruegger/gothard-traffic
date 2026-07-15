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
  integrations: [sitemap()],
});
