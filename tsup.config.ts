import { defineConfig } from 'tsup';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  define: { __PKG_VERSION__: JSON.stringify(pkg.version) },
  splitting: false,
  sourcemap: true,
  minify: false
});
