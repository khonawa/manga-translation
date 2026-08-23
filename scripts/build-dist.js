#!/usr/bin/env node
// Builds clean, loadable extension folders for Chrome and Firefox.
// Usage: node scripts/build-dist.js
// Output: dist/chrome/ and dist/firefox/ (only runtime files, no dev tooling)

import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const RUNTIME_FILES = [
  'background.js',
  'browser-polyfill.js',
  'content.js',
  'options.html',
  'options.js',
  'popup.html',
  'popup.js',
  'styles.css'
];

// Bundle the modular content script first so dist/ picks up the bundled content.js.
execFileSync(process.execPath, ['scripts/bundle-content.js'], { stdio: 'inherit' });

for (const target of ['chrome', 'firefox']) {
  // Generate the manifest for this target, then copy it into the dist folder.
  execFileSync(process.execPath, ['scripts/build-manifest.js', target], { stdio: 'inherit' });

  const dest = `dist/${target}`;
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(`${dest}/icons`, { recursive: true });
  mkdirSync(`${dest}/src/shared`, { recursive: true });

  for (const file of [...RUNTIME_FILES, 'manifest.json']) {
    copyFileSync(file, `${dest}/${file}`);
  }
  cpSync('icons', `${dest}/icons`, { recursive: true });
  cpSync('src/shared', `${dest}/src/shared`, { recursive: true });

  console.log(`dist/${target}/ ready`);
}

// Leave the working tree manifest as Chrome (the default dev target).
execFileSync(process.execPath, ['scripts/build-manifest.js', 'chrome'], { stdio: 'inherit' });
