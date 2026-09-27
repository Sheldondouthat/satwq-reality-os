#!/usr/bin/env node
/**
 * add-theme-keys.mjs — idempotent theme-key injector for Wave 5+.
 *
 * Reads new {key, label} pairs from scripts/theme-keys-wave5.json and adds
 * each `feature.*` key to:
 *   1. src/themes/engine.js — known-key list + BASE_STRINGS
 *   2. src/themes/themes.js — all 14 theme dictionaries
 *
 * Anchors on the `feature.sigmets` line (present exactly once in each
 * location). Skips keys already present. Verifies replacement counts and
 * fails loudly on mismatch (never silently half-applies).
 *
 * Usage: node scripts/add-theme-keys.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS_FILE = join(ROOT, 'scripts', 'theme-keys-wave5.json');
const ENGINE = join(ROOT, 'src', 'themes', 'engine.js');
const THEMES = join(ROOT, 'src', 'themes', 'themes.js');

const pairs = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
if (!Array.isArray(pairs) || pairs.length === 0) {
  console.error('add-theme-keys: no pairs in theme-keys-wave5.json');
  process.exit(1);
}

function escLabel(label) {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

let failures = 0;

// --- engine.js: known-key list ---
{
  const anchor = "  'feature.sigmets',\n";
  let text = readFileSync(ENGINE, 'utf8');
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    console.error(`add-theme-keys: engine.js key-list anchor found ${occurrences}x (expected 1)`);
    failures++;
  } else {
    const additions = pairs
      .filter((p) => !text.includes(`'${p.key}'`))
      .map((p) => `  '${p.key}',\n`)
      .join('');
    if (additions) {
      text = text.replace(anchor, anchor + additions);
      writeFileSync(ENGINE, text);
      console.log(`engine.js key list: +${pairs.length - (pairs.length - additions.split('\n').filter(Boolean).length)} (skipped existing)`);
    } else {
      console.log('engine.js key list: all keys already present');
    }
  }
}

// --- engine.js: BASE_STRINGS ---
{
  const anchor = "  'feature.sigmets': 'Aviation SIGMETs',\n";
  let text = readFileSync(ENGINE, 'utf8');
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 1) {
    console.error(`add-theme-keys: engine.js BASE_STRINGS anchor found ${occurrences}x (expected 1)`);
    failures++;
  } else {
    const additions = pairs
      .filter((p) => !text.includes(`'${p.key}':`))
      .map((p) => `  '${p.key}': '${p.label.replace(/'/g, "\\'")}',\n`)
      .join('');
    if (additions) {
      text = text.replace(anchor, anchor + additions);
      writeFileSync(ENGINE, text);
      console.log('engine.js BASE_STRINGS: added missing keys');
    } else {
      console.log('engine.js BASE_STRINGS: all keys already present');
    }
  }
}

// --- themes.js: all 14 dictionaries ---
{
  const anchor = `      'feature.sigmets': "Aviation SIGMETs",\n`;
  let text = readFileSync(THEMES, 'utf8');
  const occurrences = text.split(anchor).length - 1;
  if (occurrences !== 14) {
    console.error(`add-theme-keys: themes.js anchor found ${occurrences}x (expected 14)`);
    failures++;
  } else {
    const additions = pairs
      .map((p) => `      '${p.key}': "${escLabel(p.label)}",\n`)
      .join('');
    // Only add keys not already present anywhere
    const missing = pairs.filter((p) => !text.includes(`'${p.key}':`));
    if (missing.length > 0) {
      const addText = missing.map((p) => `      '${p.key}': "${escLabel(p.label)}",\n`).join('');
      text = text.split(anchor).join(anchor + addText);
      writeFileSync(THEMES, text);
      console.log(`themes.js: +${missing.length} keys × 14 themes = +${missing.length * 14} additions`);
    } else {
      console.log('themes.js: all keys already present');
    }
    void additions;
  }
}

if (failures > 0) {
  console.error(`add-theme-keys: FAILED with ${failures} anchor mismatch(es)`);
  process.exit(1);
}
console.log('add-theme-keys: OK');
