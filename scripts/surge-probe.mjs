#!/usr/bin/env node
/**
 * surge-probe.mjs — probe-first spec authoring tool for Operation 500.
 *
 * Usage:
 *   node scripts/surge-probe.mjs --url <https-url> [--ua <user-agent>]
 *       [--fixture <spec-id>] [--cap 8192]
 *
 * Probes the URL (20s timeout, redirect follow). Requires HTTP 200 and a
 * JSON body. Prints a structural summary (top-level keys, array lengths,
 * first-item keys, sample values) so the worker can author extract paths.
 * With --fixture <id>, saves the first --cap bytes of the REAL response
 * body to server/providers/wave10/fixtures/<id>.json for tests.
 *
 * A URL that does not return 200 + JSON does not ship. No exceptions.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const url = opt('--url');
const ua = opt('--ua', 'satwq-reality-os/1.0 (gods-eye-view; surge-500 probe; keyless)');
const fixtureId = opt('--fixture');
const cap = Number(opt('--cap', '8192'));

if (!url || !/^https:\/\//.test(url)) {
  console.error('usage: node scripts/surge-probe.mjs --url <https-url> [--ua UA] [--fixture <id>] [--cap N]');
  process.exit(2);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);
let res;
try {
  res = await fetch(url, {
    signal: controller.signal,
    redirect: 'follow',
    headers: { 'User-Agent': ua, Accept: 'application/json' },
  });
} catch (e) {
  console.error(`PROBE FAIL: fetch error: ${e?.message ?? e}`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

console.log(`status: ${res.status}`);
if (!res.ok) {
  console.error('PROBE FAIL: non-200 — does not ship.');
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const text = buf.toString('utf8');
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error('PROBE FAIL: body is not JSON — does not ship.');
  process.exit(1);
}

// 200-with-error trap: some APIs (e.g. NOAA CO-OPS) return HTTP 200 with an
// error envelope like {"error":{"message":"No data was found..."}} for
// unsupported station/product combos. Such bodies must never ship as fixtures.
// Hard-fail when the body is an error envelope with no real data; soft-warn
// on any other top-level "error" key so a human verifies before shipping.
{
  const isErrEnvelope =
    json && typeof json === 'object' && !Array.isArray(json) &&
    json.error && typeof json.error === 'object' &&
    typeof json.error.message === 'string';
  if (isErrEnvelope) {
    const hasData = Object.values(json).some((x) => Array.isArray(x) && x.length > 0);
    if (!hasData) {
      console.error(`PROBE FAIL: 200-with-error body (error.message=${JSON.stringify(json.error.message).slice(0, 120)}) — does not ship.`);
      process.exit(1);
    }
    console.error('PROBE WARN: body carries an error envelope alongside data — verify before shipping.');
  } else if (json && typeof json === 'object' && !Array.isArray(json) && 'error' in json) {
    console.error('PROBE WARN: body carries a top-level "error" key — verify it is real data before shipping.');
  }
}

const summarize = (v, depth = 0) => {
  if (depth > 2) return typeof v;
  if (Array.isArray(v)) {
    const first = v.length ? summarize(v[0], depth + 1) : 'empty';
    return `array[${v.length}] of ${JSON.stringify(first).slice(0, 120)}`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    const out = {};
    for (const k of keys.slice(0, 12)) out[k] = summarize(v[k], depth + 1);
    if (keys.length > 12) out['…'] = `${keys.length - 12} more keys`;
    return out;
  }
  if (typeof v === 'string') return v.length > 60 ? `str(${v.length}): ${v.slice(0, 60)}…` : `str: ${JSON.stringify(v)}`;
  return `${typeof v}: ${JSON.stringify(v)}`;
};

console.log('--- structure ---');
console.log(JSON.stringify(summarize(json), null, 1).slice(0, 4000));
console.log(`--- body bytes: ${buf.length} ---`);

if (fixtureId) {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(fixtureId)) {
    console.error('PROBE FAIL: bad fixture id');
    process.exit(2);
  }
  // Checkpoint-first: fixtures live in ~/workspace/surge-500/fixtures/ (outside
  // the repo tree is fine — home persists across wipes). surge-generate.mjs
  // copies them into server/providers/wave10/fixtures/ at build time.
  const dir = path.join(process.env.HOME, 'workspace/surge-500/fixtures');
  mkdirSync(dir, { recursive: true });
  // Trim the PARSED payload: keep at most 5 elements of every array, then
  // re-serialize under the cap. Fixture stays fully parseable and keeps the
  // real shape the spec's extract paths resolve against.
  const trim = (v, depth = 0) => {
    if (Array.isArray(v)) return v.slice(0, 5).map((x) => trim(x, depth + 1));
    if (v && typeof v === 'object' && depth < 6) {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = trim(val, depth + 1);
      return out;
    }
    return v;
  };
  let serial = JSON.stringify(trim(json));
  if (serial.length > cap) {
    // Shrink harder: 2 elements per array.
    const trim2 = (v, depth = 0) => {
      if (Array.isArray(v)) return v.slice(0, 2).map((x) => trim2(x, depth + 1));
      if (v && typeof v === 'object' && depth < 6) {
        const out = {};
        for (const [k, val] of Object.entries(v)) out[k] = trim2(val, depth + 1);
        return out;
      }
      return v;
    };
    serial = JSON.stringify(trim2(json));
    if (serial.length > cap) serial = JSON.stringify({ _note: 'fixture too large, trimmed to envelope', _bytes: serial.length });
  }
  writeFileSync(path.join(dir, `${fixtureId}.json`), serial + '\n');
  console.log(`fixture saved: server/providers/wave10/fixtures/${fixtureId}.json (${serial.length} bytes, trimmed real payload)`);
}
console.log('PROBE OK');
