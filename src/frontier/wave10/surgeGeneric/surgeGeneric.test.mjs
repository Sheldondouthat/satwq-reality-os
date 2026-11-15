/**
 * U-1b — Surge-500 generic consumer tests.
 *
 * Model purity + wiring integrity:
 *  - wired + unwired accounts for all 502 specs, disjoint (enforcement
 *    by absence is only real if the accounting closes);
 *  - every wired spec still validates and its wired metadata matches
 *    the spec module it names;
 *  - every unwired spec carries a recorded reason and is NOT wired;
 *  - renders carry the generic-path provenance + spec id, the payload's
 *    own honesty/source/attribution, stale badges, honestLabels, and
 *    fieldMap descriptions;
 *  - untrusted payload text is escaped; object values never render as
 *    "[object Object]".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  validateSpec,
  extractItems,
  applyMap,
  filterRequired,
  buildPayload,
} from '../../../../server/providers/wave10/generic.js';
import { SPECS, SPEC_IDS } from '../../../../server/providers/wave10/specs.mjs';
import { WIRED_SPECS, UNWIRED_SPECS, AUDIT_META } from './wired.mjs';
import {
  provenanceLine,
  formatValue,
  isRenderable,
  refreshMsFor,
  renderPanelHtml,
  renderItemHtml,
} from './model.js';

const wiredIds = new Set(WIRED_SPECS.map((s) => s.id));
const unwiredIds = new Set(UNWIRED_SPECS.map((s) => s.id));

test('wired + unwired accounts for every spec, disjoint', () => {
  assert.equal(AUDIT_META.totalSpecs, SPEC_IDS.length);
  assert.equal(WIRED_SPECS.length + UNWIRED_SPECS.length, SPEC_IDS.length);
  assert.equal(wiredIds.size, WIRED_SPECS.length, 'duplicate wired ids');
  assert.equal(unwiredIds.size, UNWIRED_SPECS.length, 'duplicate unwired ids');
  for (const id of SPEC_IDS) {
    assert.ok(
      wiredIds.has(id) !== unwiredIds.has(id),
      `${id} must be exactly one of wired/unwired`,
    );
  }
});

test('every wired spec validates and its metadata matches the spec module', () => {
  for (const meta of WIRED_SPECS) {
    const spec = SPECS[meta.id];
    assert.ok(spec, `wired id ${meta.id} has no spec module`);
    assert.equal(validateSpec(spec), true, meta.id);
    assert.equal(meta.title, spec.title, meta.id);
    assert.equal(meta.ttlSeconds, spec.ttlSeconds ?? 3600, meta.id);
    if (spec.fieldMap) assert.deepEqual(meta.fieldMap, spec.fieldMap, meta.id);
    if (spec.honestLabels)
      assert.deepEqual(meta.honestLabels, spec.honestLabels, meta.id);
  }
});

test('every unwired spec carries a reason and is not wired', () => {
  for (const u of UNWIRED_SPECS) {
    assert.ok(typeof u.reason === 'string' && u.reason.length > 0, u.id);
    assert.ok(!wiredIds.has(u.id), `${u.id} is both unwired and wired`);
    assert.ok(SPECS[u.id], `unwired id ${u.id} has no spec module`);
  }
});

test('fixture-refused specs are refused for a shape the fixture proves', () => {
  // The deterministic refusal class: a mapped field resolves to an
  // object / array-of-objects on the spec's own captured fixture bytes.
  for (const u of UNWIRED_SPECS.filter((x) => x.reason === 'non-scalar-field')) {
    const spec = SPECS[u.id];
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          `../../../../server/providers/wave10/fixtures/${u.id}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const rows = extractItems(spec, fixture).map((i) => applyMap(spec, i));
    const bad = rows.some((row) =>
      Object.values(row).some((v) => !isRenderable(v)),
    );
    assert.ok(bad, `${u.id}: fixture no longer proves the refusal`);
  }
});

test('provenance names the generic path and the spec id', () => {
  const line = provenanceLine('wb-gdp-usa');
  assert.match(line, /surge generic consumer/);
  assert.match(line, /spec wb-gdp-usa/);
  assert.match(line, /\/api\/wb-gdp-usa/);
});

test('formatValue renders scalars and scalar arrays, refuses objects', () => {
  assert.equal(formatValue(null), '—');
  assert.equal(formatValue(2.94), '2.94');
  assert.equal(formatValue('x'), 'x');
  assert.equal(formatValue(true), 'true');
  assert.equal(formatValue([-97.75, 30.17, 11.8]), '-97.75, 30.17, 11.8');
  assert.equal(formatValue({ lon: 2.37, lat: 48.84 }), null);
  assert.equal(formatValue([{ $type: 'Tfl' }]), null);
});

test('refreshMsFor clamps the spec ttl', () => {
  assert.equal(refreshMsFor({ ttlSeconds: 600 }), 600_000);
  assert.equal(refreshMsFor({ ttlSeconds: 30 }), 120_000);
  assert.equal(refreshMsFor({ ttlSeconds: 86400 }), 3_600_000);
  assert.equal(refreshMsFor({}), 3_600_000);
});

test('renderPanelHtml carries provenance, honesty, stale, labels, values', () => {
  const spec = SPECS['ol-search-solar'];
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../../../server/providers/wave10/fixtures/ol-search-solar.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const rows = filterRequired(
    spec,
    extractItems(spec, fixture).map((i) => applyMap(spec, i)),
  ).rows;
  const payload = buildPayload(spec, rows, true);
  const meta = WIRED_SPECS.find((s) => s.id === 'ol-search-solar');
  assert.ok(meta, 'ol-search-solar must be wired for this render test');
  const html = renderPanelHtml(meta, payload);
  assert.match(html, /surge generic consumer/);
  assert.match(html, /spec ol-search-solar/);
  assert.match(html, /Open Library/);
  assert.match(html, /STALE/);
  assert.match(html, /full-text search for the fixed query/); // payload honesty
  assert.match(html, /coverage:/); // honestLabels rendered labeled
  assert.match(html, /work title/); // fieldMap description
  assert.match(html, /Data: Open Library/); // attribution
  assert.ok(!html.includes('[object Object]'));
});

test('renderPanelHtml escapes untrusted payload text', () => {
  const meta = { id: 'x-test', title: 'X', ttlSeconds: 600 };
  const payload = {
    id: 'x-test',
    source: '<script>alert(1)</script>',
    attribution: 'a & b',
    honesty: 'h<onesty',
    count: 1,
    generatedAt: '2026-11-15T00:00:00Z',
    stale: false,
    items: [{ name: '<img src=x onerror=alert(1)>' }],
  };
  const html = renderPanelHtml(meta, payload);
  assert.ok(!html.includes('<script>'), 'source must be escaped');
  assert.ok(!html.includes('<img src=x'), 'item values must be escaped');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

test('renderItemHtml badges stale items with their own age', () => {
  const html = renderItemHtml(
    { id: 'usgs-water-newriver-valley' },
    { name: 'Glen Lyn', value: 1390, stale: true, ageSeconds: 7200 },
  );
  assert.match(html, /stale item/);
  assert.match(html, /7200s old/);
  assert.ok(!html.includes('ageSeconds'), 'raw staleness fields not printed');
});
