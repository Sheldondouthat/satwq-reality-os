#!/usr/bin/env node
/**
 * Import-target presence check (batch acceptance criteria).
 *
 * Every file imported by COMMITTED code must itself be COMMITTED.
 * A commit whose code imports untracked files passes local build/test
 * (files present in tree) but breaks downstream deploys (vite/rollup
 * "Could not resolve" on the pristine checkout).
 *
 * Root cause of 74db66c/f1cd03a Pages failures (2026-09-27): oceanTwin/index.js
 * imported ../argo/source.js while src/frontier/wave3/argo/ was untracked.
 *
 * Run before every batch commit: node scripts/check-import-targets.mjs
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';

function trackedFiles() {
  const out = execSync('git ls-files -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return new Set(out.split('\0').filter(Boolean));
}

function untrackedFiles() {
  const out = execSync('git status --porcelain -z', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = [];
  for (const entry of out.split('\0')) {
    if (entry.startsWith('?? ')) files.push(entry.slice(3));
  }
  return new Set(files);
}

// Extract relative import specifiers: from '...', import('...'), import '...'
function relativeImports(src) {
  const specs = new Set();
  for (const re of [
    /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"](\.[^'"]+)['"]/g,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]) {
    let m;
    while ((m = re.exec(src))) specs.add(m[1]);
  }
  return specs;
}

// Resolve a relative specifier to candidate repo-relative paths.
function resolveCandidates(fromFile, spec) {
  const dir = dirname(fromFile);
  const abs = resolve(dir, spec);
  const cands = [abs];
  // Extensionless: try .js, .mjs, /index.js, .json
  if (!extname(abs)) {
    for (const ext of ['.js', '.mjs', '.json']) cands.push(abs + ext);
    cands.push(resolve(abs, 'index.js'));
  }
  // Make repo-relative
  const cwd = process.cwd() + '/';
  return cands
    .filter((p) => p.startsWith(cwd))
    .map((p) => p.slice(cwd.length));
}

function main() {
  const tracked = trackedFiles();
  const untracked = untrackedFiles();
  const jsFiles = [...tracked].filter((f) => /\.(m?js)$/.test(f) && !f.includes('node_modules'));

  const violations = [];
  for (const file of jsFiles) {
    let src;
    try { src = readFileSync(file, 'utf8'); } catch { continue; }
    for (const spec of relativeImports(src)) {
      const cands = resolveCandidates(file, spec);
      // Find which candidate actually exists on disk
      const hit = cands.find((c) => existsSync(c));
      if (!hit) continue; // not resolvable locally either — different check's job
      if (untracked.has(hit)) {
        violations.push({ importer: file, spec, target: hit });
      }
    }
  }

  if (violations.length === 0) {
    console.log(`IMPORT-TARGETS OK: ${jsFiles.length} committed JS files, no imports resolve to untracked files`);
    process.exit(0);
  }

  console.log(`IMPORT-TARGETS FAIL: ${violations.length} committed file(s) import UNTRACKED targets:`);
  const seen = new Set();
  for (const { importer, spec, target } of violations) {
    const key = `${importer}→${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`  - ${importer}\n      imports '${spec}' → UNTRACKED: ${target}`);
  }
  console.log('\nFix: git add the target files before committing.');
  process.exit(1);
}

main();
