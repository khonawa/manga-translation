#!/usr/bin/env node
// Usage:
//   node scripts/build-manifest.js chrome   → writes manifest.json for Chrome
//   node scripts/build-manifest.js firefox  → writes manifest.json for Firefox

import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!['chrome', 'firefox'].includes(target)) {
  console.error('Usage: node scripts/build-manifest.js [chrome|firefox]');
  process.exit(1);
}

const base = JSON.parse(readFileSync('manifest.base.json', 'utf8'));
const override = JSON.parse(readFileSync(`manifest.${target}.json`, 'utf8'));

// Deep merge: arrays in override replace arrays in base (no concat).
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object')
      ? merge(a[k] ?? {}, v)
      : v;
  }
  return out;
}

writeFileSync('manifest.json', JSON.stringify(merge(base, override), null, 2));
console.log(`manifest.json written for ${target}`);
