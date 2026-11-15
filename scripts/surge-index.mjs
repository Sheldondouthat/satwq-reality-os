#!/usr/bin/env node
/**
 * surge-index.mjs — regenerate the Surge-500 spec index of record.
 *
 *   server/providers/wave10/specs.mjs — SPECS index
 *
 * The index covers EVERY committed spec module in
 * server/providers/wave10/specs/*.mjs. It is deliberately decoupled from
 * scripts/surge-generate.mjs's JSON input corpus (~/workspace/surge-500/
 * specs/*.json): that corpus holds only the specs of the run in flight,
 * so an index generated from it alone shrinks to that run — the BM2 run
 * (2026-11-15) regenerated the index down to 1 of 502 specs, and
 * src/surge/specs-index.test.mjs kept passing on the one room it checked
 * (DELTA-SWEEP-II U-1a). surge-generate.mjs now builds its index through
 * this same module, over the union of its inputs and every committed
 * spec module, so the two paths can never disagree.
 *
 * Usage: node scripts/surge-index.mjs [--check]
 *   --check: validate only, write nothing (CI-friendly); fails if the
 *   committed index differs from the index the specs directory implies.
 *
 * A spec module whose SPEC.id does not match its filename does not ship
 * (hard fail). A spec that fails validateSpec does not ship (hard fail).
 * Duplicate ids or duplicate upstream urls do not ship (hard fail).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_MODULE_DIR = path.join(repoRoot, 'server/providers/wave10/specs');
const INDEX_PATH = path.join(repoRoot, 'server/providers/wave10/specs.mjs');

/**
 * The index file's exact bytes for a sorted id list. Single format owner:
 * surge-generate.mjs emits its index through here too.
 */
export function buildIndexSource(ids) {
  return (
    `/**\n * Surge-500 spec index — AUTO-GENERATED. Do not edit by hand.\n * Regenerate: node scripts/surge-index.mjs\n */\n` +
    ids.map((id) => `import { SPEC as _${id.replace(/-/g, '_')} } from './specs/${id}.mjs';`).join('\n') +
    `\n\nexport const SPECS = {\n` +
    ids.map((id) => `  '${id}': _${id.replace(/-/g, '_')},`).join('\n') +
    `\n};\n\nexport const SPEC_IDS = Object.keys(SPECS);\n`
  );
}

/** Sorted ids of every committed spec module, fully validated. */
export async function collectSpecIds() {
  const { validateSpec } = await import(path.join(repoRoot, 'server/providers/wave10/generic.js'));
  const files = existsSync(SPEC_MODULE_DIR)
    ? readdirSync(SPEC_MODULE_DIR).filter((f) => f.endsWith('.mjs')).sort()
    : [];
  const ids = [];
  const urls = new Set();
  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(SPEC_MODULE_DIR, file)).href);
    const spec = mod.SPEC;
    const base = file.replace(/\.mjs$/, '');
    if (!spec || typeof spec.id !== 'string') {
      console.error(`surge-index FAIL: ${file} exports no SPEC with an id`);
      process.exit(1);
    }
    if (spec.id !== base) {
      console.error(`surge-index FAIL: ${file}: filename must match spec.id '${spec.id}'`);
      process.exit(1);
    }
    try {
      validateSpec(spec);
    } catch (e) {
      console.error(`surge-index FAIL: ${file}: ${e.message}`);
      process.exit(1);
    }
    if (ids.includes(spec.id)) {
      console.error(`surge-index FAIL: duplicate id ${spec.id}`);
      process.exit(1);
    }
    if (urls.has(spec.url)) {
      console.error(`surge-index FAIL: duplicate url ${spec.url} (${spec.id})`);
      process.exit(1);
    }
    ids.push(spec.id);
    urls.add(spec.url);
  }
  return ids.sort();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const checkOnly = process.argv.includes('--check');
  const ids = await collectSpecIds();
  const source = buildIndexSource(ids);
  if (checkOnly) {
    const current = existsSync(INDEX_PATH) ? readFileSync(INDEX_PATH, 'utf8') : '';
    if (current !== source) {
      console.error(`surge-index FAIL: specs.mjs is stale — it does not index all ${ids.length} committed specs. Run: node scripts/surge-index.mjs`);
      process.exit(1);
    }
    console.log(`surge-index: --check OK (${ids.length} specs indexed)`);
  } else {
    writeFileSync(INDEX_PATH, source);
    console.log(`surge-index done: ${ids.length} specs indexed in server/providers/wave10/specs.mjs`);
  }
}
