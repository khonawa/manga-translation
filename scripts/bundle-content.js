#!/usr/bin/env node
// Bundles the modular content script (src/content/index.js) back into the single
// classic-script file Chrome injects (root content.js). esbuild's iife format
// restores the original `(() => { ... })();` wrapper, so the bundled output behaves
// identically to the old hand-written monolith.

import { buildSync } from 'esbuild';

buildSync({
  entryPoints: ['src/content/index.js'],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: 'content.js',
  logLevel: 'info'
});

console.log('content.js bundled');
