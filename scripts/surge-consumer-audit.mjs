#!/usr/bin/env node
/**
 * surge-consumer-audit.mjs — U-1b admissibility + liveness audit for the
 * Surge-500 generic consumer (src/frontier/wave10/surgeGeneric/).
 *
 * The generic consumer renders a wave-10 spec ONLY if the spec is
 * (a) spec-complete for the generic path — its extraction resolves on its
 *     own captured fixture bytes, every mapped value is a flat scalar the
 *     panel can print honestly (never "[object Object]"), and at least one
 *     row survives the required-field filter (or the spec declares
 *     honestEmpty, where an empty list is a real answer); and
 * (b) verifiably live TODAY — one real fetch of the spec's own URL through
 *     the engine's fetch semantics (UA, spec headers, body cap, timeout)
 *     whose bytes extract to rows (or, for honestEmpty specs, to a
 *     resolvable array).
 *
 * Everything else stays UNWIRED with its reason recorded — enforcement by
 * absence: an unwired spec never appears in the consumer's picker.
 *
 * Usage:
 *   node scripts/surge-consumer-audit.mjs            # fixture phase only
 *   node scripts/surge-consumer-audit.mjs --live     # + live phase
 *   node scripts/surge-consumer-audit.mjs --live --write
 *        # + regenerate src/frontier/wave10/surgeGeneric/wired.mjs and
 *        #   write the full report to /tmp/surge-consumer-audit.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIRED_PATH = path.join(
  repoRoot,
  'src/frontier/wave10/surgeGeneric/wired.mjs',
);
const REPORT_PATH = '/tmp/surge-consumer-audit.json';
const DEFAULT_UA =
  'satwq-reality-os/1.0 (gods-eye-view; surge-500 layer; keyless)';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BODY_CAP = 2 * 1024 * 1024;
const CONCURRENCY = 6;

const { SPECS, SPEC_IDS } = await import(
  pathToFileURL(path.join(repoRoot, 'server/providers/wave10/specs.mjs')).href
);
const engine = await import(
  pathToFileURL(path.join(repoRoot, 'server/providers/wave10/generic.js')).href
);
const { validateSpec, extractItems, applyMap, filterRequired, buildPayload,
  annotateItemStaleness } = engine;

function isScalar(v) {
  return v == null || typeof v === 'string' || typeof v === 'number' ||
    typeof v === 'boolean';
}

/**
 * Renderable by the generic panel: a scalar, or an array of scalars
 * (printed joined — a faithful rendering, nothing chosen or invented).
 * Objects and arrays containing objects are NOT renderable: flattening
 * them (picking keys, assuming GeoJSON axis order) would be presentation
 * the spec never declared.
 */
function isRenderable(v) {
  return isScalar(v) || (Array.isArray(v) && v.every(isScalar));
}

/** Fixture phase: can the generic path honor this spec's declared shape? */
function assessFixture(spec) {
  try {
    validateSpec(spec);
  } catch (e) {
    return { ok: false, reason: 'spec-invalid', detail: e.message };
  }
  let fixture;
  try {
    fixture = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          `server/providers/wave10/fixtures/${spec.id}.json`,
        ),
        'utf8',
      ),
    );
  } catch (e) {
    return { ok: false, reason: 'fixture-unreadable', detail: e.message };
  }
  const raw = extractItems(spec, fixture);
  const itemsPath = engine.resolvePath(fixture, spec.extract.items);
  if (!Array.isArray(itemsPath)) {
    return { ok: false, reason: 'fixture-items-unresolvable',
      detail: `extract.items '${spec.extract.items}' does not resolve to an array on the captured fixture` };
  }
  const rows = raw.map((item) => applyMap(spec, item));
  for (const row of rows) {
    for (const [field, v] of Object.entries(row)) {
      if (!isRenderable(v)) {
        return { ok: false, reason: 'non-scalar-field', detail: field };
      }
    }
  }
  const { rows: kept } = filterRequired(spec, rows);
  if (kept.length === 0 && spec.honestEmpty !== true) {
    return { ok: false, reason: 'fixture-no-rows',
      detail: `extraction resolves but 0 rows survive the required-field filter on the fixture (extracted=${raw.length})` };
  }
  return { ok: true, fixtureRows: kept.length };
}

/** Live phase: one fetch through the engine's fetch semantics. */
async function assessLive(spec) {
  const controller = new AbortController();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(spec.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULT_UA,
        Accept: 'application/json',
        ...(spec.headers ?? {}),
      },
    });
    if (!response.ok) {
      return { ok: false, reason: 'live-upstream-error',
        detail: `HTTP ${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const cap = spec.bodyCapBytes ?? DEFAULT_BODY_CAP;
    if (buffer.byteLength > cap) {
      return { ok: false, reason: 'live-too-large',
        detail: `${buffer.byteLength} bytes > cap ${cap}` };
    }
    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(buffer));
    } catch {
      return { ok: false, reason: 'live-bad-json',
        detail: 'upstream body is not JSON' };
    }
    if (!Array.isArray(engine.resolvePath(payload, spec.extract.items))) {
      return { ok: false, reason: 'live-items-unresolvable',
        detail: `extract.items '${spec.extract.items}' does not resolve to an array on live bytes` };
    }
    const raw = extractItems(spec, payload);
    const rows = raw.map((item) => applyMap(spec, item));
    for (const row of rows) {
      for (const [field, v] of Object.entries(row)) {
        if (!isRenderable(v)) {
          return { ok: false, reason: 'non-scalar-field-live',
            detail: field };
        }
      }
    }
    const { rows: kept } = filterRequired(spec, rows);
    if (kept.length === 0) {
      if (spec.honestEmpty === true) {
        return { ok: true, liveRows: 0, honestEmptyLive: true };
      }
      return { ok: false, reason: 'live-no-rows',
        detail: `live extraction yields 0 rows (extracted=${raw.length})` };
    }
    const built = buildPayload(spec, kept, false);
    const staleItems = annotateItemStaleness(spec, built.items);
    return {
      ok: true,
      liveRows: kept.length,
      staleItemCount: staleItems,
      sample: kept[0],
    };
  } catch (error) {
    return { ok: false, reason: 'live-upstream-error',
      detail: String(error?.message ?? error).slice(0, 200) };
  } finally {
    clearTimeout(timeout);
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

const doLive = process.argv.includes('--live');
const doWrite = process.argv.includes('--write');
const doReprobe = process.argv.includes('--reprobe');

/**
 * --reprobe: load the report a --live --write run produced, sequentially
 * re-probe ONLY the specs it left unwired on a fetch timeout ('aborted' —
 * the one failure class a contended VM manufactures), and rewrite
 * wired.mjs + the report with the merged result. HTTP answers (403/429/
 * 503…) are the upstream speaking and are NOT re-probed: a 429 is a hard
 * stop, not a retry invitation.
 */
if (doReprobe) {
  const { existsSync } = await import('node:fs');
  if (!existsSync(REPORT_PATH) || !existsSync(WIRED_PATH)) {
    console.error('--reprobe needs a prior --live --write run');
    process.exit(1);
  }
  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  const targets = report.unwired.filter(
    (u) =>
      u.reason === 'live-upstream-error' && /aborted/i.test(u.detail ?? ''),
  );
  console.log(`reprobe: ${targets.length} timeout-unwired specs, sequential`);
  const flipped = [];
  for (const u of targets) {
    const r = await assessLive(SPECS[u.id]);
    console.log(`  ${u.id}: ${r.ok ? `LIVE (${r.liveRows} rows)` : `${r.reason} — ${r.detail}`}`);
    if (r.ok) {
      flipped.push(u.id);
      report.wired.push({
        id: u.id,
        liveRows: r.liveRows ?? null,
        honestEmptyLive: r.honestEmptyLive ?? false,
        staleItemCount: r.staleItemCount ?? 0,
        sample: r.sample ?? null,
        reprobed: true,
      });
      report.unwired = report.unwired.filter((x) => x.id !== u.id);
    } else {
      u.detail = `${u.detail} · reprobe ${new Date().toISOString()}: ${r.reason} — ${r.detail}`;
    }
  }
  report.wiredCount = report.wired.length;
  report.unwiredCount = report.unwired.length;
  report.reprobe = { at: new Date().toISOString(), flipped };
  const wiredMeta = report.wired
    .map((w) => {
      const s = SPECS[w.id];
      const meta = { id: s.id, title: s.title, ttlSeconds: s.ttlSeconds ?? 3600 };
      if (s.units && Object.keys(s.units).length) meta.units = s.units;
      if (s.fieldMap) meta.fieldMap = s.fieldMap;
      if (s.honestLabels) meta.honestLabels = s.honestLabels;
      return meta;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  const unwiredList = report.unwired
    .map(({ id, reason }) => ({ id, reason }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const source =
    `/**\n * Surge-500 generic consumer wiring — AUTO-GENERATED by\n * scripts/surge-consumer-audit.mjs --live --write. Do not edit by hand.\n *\n * A spec is WIRED only if it is spec-complete for the generic path AND\n * verifiably live on the audit date. Everything else is UNWIRED with its\n * reason recorded — enforcement by absence: an unwired spec never\n * appears in the consumer. Regenerate to re-audit.\n */\n` +
    `export const AUDIT_META = ${JSON.stringify(
      {
        generatedAt: report.generatedAt,
        totalSpecs: report.totalSpecs,
        wiredCount: wiredMeta.length,
        unwiredCount: unwiredList.length,
        reprobe: report.reprobe,
      },
      null,
      2,
    )};\n\n` +
    `export const WIRED_SPECS = ${JSON.stringify(wiredMeta, null, 2)};\n\n` +
    `export const UNWIRED_SPECS = ${JSON.stringify(unwiredList, null, 2)};\n`;
  writeFileSync(WIRED_PATH, source);
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(
    `reprobe done: flipped ${flipped.length} (${flipped.join(', ') || 'none'}); ` +
      `wired ${report.wiredCount}, unwired ${report.unwiredCount}`,
  );
  process.exit(0);
}

const results = new Map();
for (const id of SPEC_IDS) {
  const spec = SPECS[id];
  results.set(id, { id, fixture: assessFixture(spec) });
}

let liveCount = 0;
if (doLive) {
  const admissible = SPEC_IDS.filter((id) => results.get(id).fixture.ok);
  console.log(
    `fixture phase: ${admissible.length}/${SPEC_IDS.length} admissible; live-probing…`,
  );
  const liveResults = await pool(admissible, CONCURRENCY, async (id) => {
    const r = await assessLive(SPECS[id]);
    liveCount++;
    if (liveCount % 50 === 0)
      console.log(`  live ${liveCount}/${admissible.length}`);
    return [id, r];
  });
  for (const [id, r] of liveResults) results.get(id).live = r;
}

const wired = [];
const unwired = [];
for (const id of SPEC_IDS) {
  const r = results.get(id);
  if (!r.fixture.ok) {
    unwired.push({ id, reason: r.fixture.reason, detail: r.fixture.detail });
  } else if (doLive && !r.live?.ok) {
    unwired.push({
      id,
      reason: r.live?.reason ?? 'live-not-run',
      detail: r.live?.detail ?? '',
    });
  } else {
    wired.push(id);
  }
}

const reasonCounts = {};
for (const u of unwired) reasonCounts[u.reason] = (reasonCounts[u.reason] ?? 0) + 1;
console.log(
  `audit: ${SPEC_IDS.length} specs — wired ${wired.length}, unwired ${unwired.length}` +
    (doLive ? '' : ' (fixture phase only; liveness not probed)'),
);
for (const [reason, n] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1]))
  console.log(`  unwired/${reason}: ${n}`);

if (doWrite) {
  if (!doLive) {
    console.error('--write requires --live (the wired list is a liveness claim)');
    process.exit(1);
  }
  const wiredMeta = wired
    .map((id) => {
      const s = SPECS[id];
      const meta = { id: s.id, title: s.title, ttlSeconds: s.ttlSeconds ?? 3600 };
      if (s.units && Object.keys(s.units).length) meta.units = s.units;
      if (s.fieldMap) meta.fieldMap = s.fieldMap;
      if (s.honestLabels) meta.honestLabels = s.honestLabels;
      return meta;
    })
    .sort((a, b) => a.title.localeCompare(b.title));
  const unwiredList = unwired
    .map(({ id, reason }) => ({ id, reason }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const source =
    `/**\n * Surge-500 generic consumer wiring — AUTO-GENERATED by\n * scripts/surge-consumer-audit.mjs --live --write. Do not edit by hand.\n *\n * A spec is WIRED only if it is spec-complete for the generic path AND\n * verifiably live on the audit date. Everything else is UNWIRED with its\n * reason recorded — enforcement by absence: an unwired spec never\n * appears in the consumer. Regenerate to re-audit.\n */\n` +
    `export const AUDIT_META = ${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totalSpecs: SPEC_IDS.length,
        wiredCount: wiredMeta.length,
        unwiredCount: unwiredList.length,
      },
      null,
      2,
    )};\n\n` +
    `export const WIRED_SPECS = ${JSON.stringify(wiredMeta, null, 2)};\n\n` +
    `export const UNWIRED_SPECS = ${JSON.stringify(unwiredList, null, 2)};\n`;
  writeFileSync(WIRED_PATH, source);
  const report = {
    generatedAt: new Date().toISOString(),
    totalSpecs: SPEC_IDS.length,
    wiredCount: wired.length,
    unwiredCount: unwired.length,
    reasonCounts,
    wired: wired.map((id) => ({
      id,
      liveRows: results.get(id).live?.liveRows ?? null,
      honestEmptyLive: results.get(id).live?.honestEmptyLive ?? false,
      staleItemCount: results.get(id).live?.staleItemCount ?? 0,
      sample: results.get(id).live?.sample ?? null,
    })),
    unwired,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`wrote ${WIRED_PATH}`);
  console.log(`wrote ${REPORT_PATH}`);
}
