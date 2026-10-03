/**
 * Wave 9 — EPA Superfund NPL sites tests.
 *
 * Fixtures: server/providers/wave9/fixtures/superfund-va-final-2026-10-02.json
 * (29 REAL rows, captured live 2026-10-02 from
 *  https://data.epa.gov/dmapservice/sems.envirofacts_site/npl_status_code/equals/F/fk_ref_state_code/equals/VA/1:30/JSON)
 * and superfund-proposed-sample-2026-10-02.json (3 REAL proposed rows).
 * Expected summary values were computed by an INDEPENDENT python3 statement
 * over the same bytes, never invented: VA rows=29, federal-Y=11,
 * Yorktown 37.284722/-76.6075, national final=1337 (fixture-independent check
 * in run notes, not pinned here).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildDmapUrl,
  parseNplSites,
  buildPayload,
  parseQuery,
  numOrNull,
  latOrNull,
  lonOrNull,
  _superfundInternals as internals,
} from './superfund.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const VA_FIXTURE = readFileSync(
  join(ROOT, 'server', 'providers', 'wave9', 'fixtures', 'superfund-va-final-2026-10-02.json'),
  'utf8'
);
const PROPOSED_FIXTURE = readFileSync(
  join(ROOT, 'server', 'providers', 'wave9', 'fixtures', 'superfund-proposed-sample-2026-10-02.json'),
  'utf8'
);

function vaRows() {
  return parseNplSites(VA_FIXTURE).rows;
}

test('VA final-NPL fixture: 29 rows match the independent python3 count', () => {
  const rows = vaRows();
  assert.equal(rows.length, 29);
  // every row has a name and EPA-primary coords (no nulls in this fixture)
  for (const r of rows) {
    assert.ok(r.name.length > 0);
    assert.ok(r.lat != null && r.lon != null, `${r.epaId} missing coords`);
    assert.equal(r.status, 'final');
  }
});

test('federal-facility count and Yorktown coords match the independent statement', () => {
  const rows = vaRows();
  assert.equal(rows.filter((r) => r.federalFacility).length, 11);
  const york = rows.find((r) => r.epaId === 'VA3170024605');
  assert.ok(york, 'NWS YORKTOWN - CHEATHAM ANNEX present');
  assert.equal(york.lat, 37.284722);
  assert.equal(york.lon, -76.6075);
  assert.equal(york.city, 'YORKTOWN');
});

test('proposed sample: 3 rows, all proposed status', () => {
  const { rows } = parseNplSites(PROPOSED_FIXTURE);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.equal(r.status, 'proposed');
});

test('buildPayload: summary counts, topStates, honesty block', () => {
  const payload = buildPayload(vaRows(), false, { status: 'F', state: 'VA' });
  assert.equal(payload.summary.total, 29);
  assert.equal(payload.summary.byStatus.final, 29);
  assert.equal(payload.summary.byStatus.proposed, 0);
  assert.equal(payload.summary.topStates[0].state, 'VA');
  assert.equal(payload.summary.topStates[0].count, 29);
  assert.equal(payload.scope.state, 'VA');
  assert.equal(payload.stale, false);
  assert.ok(payload.honesty.npl.includes('National Priorities List'));
  assert.ok(payload.honesty.noDates.includes('no listing dates'));
  assert.ok(payload.generatedAt);
});

test('buildPayload merges final + proposed (national shape)', () => {
  const rows = [...vaRows(), ...parseNplSites(PROPOSED_FIXTURE).rows];
  const payload = buildPayload(rows, false, { status: 'A', state: 'national' });
  assert.equal(payload.summary.total, 32);
  assert.equal(payload.summary.byStatus.final, 29);
  assert.equal(payload.summary.byStatus.proposed, 3);
});

test('numOrNull/latOrNull/lonOrNull: empty/null guarded, real zeros preserved', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('37.284722'), 37.284722);
  assert.equal(numOrNull('0'), 0); // real zero preserved
  assert.equal(latOrNull('7932671.19'), null); // GPS-glitch class (R4788 precedent)
  assert.equal(latOrNull('37.28'), 37.28);
  assert.equal(lonOrNull('200'), null);
  assert.equal(lonOrNull('-76.6075'), -76.6075);
});

test('corrupt lat row parses to null lat, never a bogus position', () => {
  const text = JSON.stringify([
    { epa_id: 'XX0000000001', name: 'GLITCH SITE', npl_status_code: 'F', npl_status_name: 'Currently on the Final NPL', primary_latitude_decimal_val: '7932671.19', primary_longitude_decimal_val: '-76.6', fk_ref_state_code: 'VA' },
  ]);
  const { rows } = parseNplSites(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lat, null);
  assert.equal(rows[0].lon, -76.6);
});

test('nameless rows are skipped, never guessed', () => {
  const text = JSON.stringify([
    { epa_id: 'XX1', name: '  ', npl_status_code: 'F', fk_ref_state_code: 'VA' },
    { epa_id: 'XX2', name: 'REAL SITE', npl_status_code: 'F', fk_ref_state_code: 'VA' },
  ]);
  assert.equal(parseNplSites(text).rows.length, 1);
});

test('bad upstream shape throws 502-class errors (never 500)', () => {
  assert.throws(() => parseNplSites('<html>nope</html>'), /superfund_bad_json/);
  assert.throws(() => parseNplSites('{"error":"bad"}'), /superfund_bad_shape/);
  for (const fn of [
    () => parseNplSites('<html>nope</html>'),
    () => parseNplSites('{"error":"bad"}'),
  ]) {
    try { fn(); assert.fail('should have thrown'); } catch (e) { assert.equal(e.status, 502); }
  }
});

test('buildDmapUrl: program.table grammar, filters, JSON suffix', () => {
  const u = buildDmapUrl('F', null);
  assert.ok(u.startsWith('https://data.epa.gov/dmapservice/sems.envirofacts_site/'), u);
  assert.ok(u.includes('npl_status_code/equals/F'), u);
  assert.ok(u.endsWith('/JSON'), u);
  const vs = buildDmapUrl('F', 'VA');
  assert.ok(vs.includes('fk_ref_state_code/equals/VA'), vs);
  const vp = buildDmapUrl('P', null);
  assert.ok(vp.includes('npl_status_code/equals/P'), vp);
});

test('parseQuery: defaults, case-insensitivity, 400s', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('')), { status: 'A', state: null });
  assert.deepEqual(parseQuery(new URLSearchParams('status=f')), { status: 'F', state: null });
  assert.deepEqual(parseQuery(new URLSearchParams('status=P&state=va')), { status: 'P', state: 'VA' });
  assert.equal(parseQuery(new URLSearchParams('status=X')).badParam, 'superfund_bad_status');
  assert.equal(parseQuery(new URLSearchParams('state=VAX')).badParam, 'superfund_bad_state');
  assert.equal(parseQuery(new URLSearchParams('state=1A')).badParam, 'superfund_bad_state');
});

test('internals exported for the proxy (pattern check)', () => {
  assert.equal(typeof internals.buildDmapUrl, 'function');
  assert.equal(typeof internals.parseNplSites, 'function');
  assert.equal(typeof internals.buildPayload, 'function');
  assert.equal(typeof internals.resetCache, 'function');
  assert.equal(internals.TABLE, 'sems.envirofacts_site');
});
