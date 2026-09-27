#!/usr/bin/env node
/**
 * Dual-registry presence check (batch acceptance criteria).
 *
 * Every server provider must be registered in BOTH:
 *   1. server/providers/local.js          (dev/standalone server)
 *   2. server/pages/registry.mjs          (Cloudflare Pages Functions)
 *
 * A provider in local.js only is "dev-only, invisible in production."
 * Run before every batch commit: node scripts/check-dual-registry.mjs
 *
 * Deliberate exclusions (documented in registry.mjs header) are allowlisted.
 */

import { readFileSync } from 'node:fs';

const LOCAL_JS = 'server/providers/local.js';
const PAGES_REGISTRY = 'server/pages/registry.mjs';

// Providers deliberately excluded from the Pages registry (documented, not failures).
// Values are substrings matched against the local.js import path.
const DELIBERATE_EXCLUSIONS = [
  'vessels/ais-live.js',      // keyed WebSocket, no key on Pages
  'local-receivers.js',       // LAN-local, unreachable from edge
  'standalone/key-setup',     // writes local .env, no writable fs on Pages
  'providers/wind.js',        // superseded by windSnapshot.mjs on Pages
];

// Extract "import { xProxy } from './path/to/file.js'" from local.js
function importsInLocalJs(src) {
  const re = /^import\s*\{\s*([a-zA-Z0-9_]+Proxy)\s*\}\s*from\s*'([^']+)'/gm;
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push({ proxy: m[1], path: m[2] });
  return out;
}

// Extract "import('../providers/...')" paths from pages/registry.mjs
function providersInPagesRegistry(src) {
  const re = /import\('\.\.\/(providers\/[^']+)'\)/g;
  const out = new Set();
  let m;
  while ((m = re.exec(src))) out.add(m[1]); // e.g. "providers/wave3/ripestat.js"
  return out;
}

function main() {
  const localSrc = readFileSync(LOCAL_JS, 'utf8');
  const regSrc = readFileSync(PAGES_REGISTRY, 'utf8');

  const localImports = importsInLocalJs(localSrc);
  const regProviders = providersInPagesRegistry(regSrc);

  const missing = [];
  for (const { proxy, path } of localImports) {
    // Normalize local.js relative path to registry-relative form.
    // local.js: './wave3/ripestat.js' or './aircraft/opensky.js' or '../x.js'
    // registry: 'providers/wave3/ripestat.js'
    let norm = path.replace(/^\.\//, 'providers/');
    if (path.startsWith('../')) norm = path.replace(/^\.\.\//, '');

    if (DELIBERATE_EXCLUSIONS.some((ex) => norm.includes(ex))) continue;
    if (!regProviders.has(norm)) missing.push({ proxy, path, norm });
  }

  if (missing.length === 0) {
    console.log(`DUAL-REGISTRY OK: ${localImports.length} local imports, all present in pages/registry.mjs (exclusions allowlisted)`);
    process.exit(0);
  }

  console.log(`DUAL-REGISTRY FAIL: ${missing.length} provider(s) in local.js but NOT in pages/registry.mjs:`);
  for (const { proxy, norm } of missing) console.log(`  - ${proxy}  (${norm})`);
  process.exit(1);
}

main();
