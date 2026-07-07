import { defineConfig } from 'astro/config';

// Static output only - no server/adapter needed. Build once (locally or in CI),
// then upload the contents of dist/ to any plain HTML/PHP web host.
export default defineConfig({
  output: 'static',
  site: 'https://www.gotthard-traffic.example',
  trailingSlash: 'never',
  compressHTML: true,
  build: {
    format: 'file',
  },
});
