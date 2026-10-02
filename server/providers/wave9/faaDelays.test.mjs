/**
 * Wave 9 (R2-13) — faaDelays provider tests (co-located).
 *
 * Fixture is REAL upstream bytes captured live 2026-10-02 from
 * https://nasstatus.faa.gov/api/airport-status-information (FAA NAS
 * status, keyless XML): one Ground Delay Program (BOS, runway
 * construction, avg "1 hour and 5 minutes", max "3 hours and 4 minutes")
 * and two Airport Closures (LAX transient-GA closure, PHL wingspan
 * restriction). Update_Time "Fri Oct 2 11:46:31 2026 GMT".
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  parseNasStatus,
  filterByAirport,
  countItems,
  buildPayload,
  updateAgeMinutes,
  decodeEntities,
  firstTag,
  allBlocks,
  _faaDelaysInternals,
} from './faaDelays.js';

const UPSTREAM_URL = _faaDelaysInternals.UPSTREAM_URL;

const REAL_BODY = `<AIRPORT_STATUS_INFORMATION><Update_Time>Fri Oct 2 11:46:31 2026 GMT</Update_Time><Dtd_File>http://www.fly.faa.gov/AirportStatus.dtd</Dtd_File><Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>BOS</ARPT><Reason>runway construction</Reason><Avg>1 hour and 5 minutes</Avg><Max>3 hours and 4 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type><Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>!LAX 05/277 LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT EXC 24HR PPR CTC ATLANTIC AVIATION 310-258-9884 OR SIGNATURE AVIATION 310-410-9605 2605271826-2705281600</Reason><Start>May 27 at 18:26 UTC.</Start><Reopen>May 28 at 16:00 UTC.</Reopen></Airport><Airport><ARPT>PHL</ARPT><Reason>!PHL 09/263 PHL AD AP CLSD TO NON SKED ACFT WINGSPAN MORE THAN 214FT AND TAIL HGT MORE THAN 66FT. 2609301806-2610311200</Reason><Start>Sep 30 at 18:06 UTC.</Start><Reopen>Oct 31 at 12:00 UTC.</Reopen></Airport></Airport_Closure_List></Delay_type></AIRPORT_STATUS_INFORMATION>`;

const QUIET_BODY = `<AIRPORT_STATUS_INFORMATION><Update_Time>Fri Oct 2 11:46:31 2026 GMT</Update_Time></AIRPORT_STATUS_INFORMATION>`;

test('upstream URL is the NAS status feed', () => {
  assert.equal(UPSTREAM_URL, 'https://nasstatus.faa.gov/api/airport-status-information');
});

test('decodeEntities handles the XML entities FAA emits', () => {
  assert.equal(decodeEntities('A &amp; B'), 'A & B');
  assert.equal(decodeEntities('5 &lt; 6 &gt; 4'), '5 < 6 > 4');
  assert.equal(decodeEntities('&quot;q&quot;'), '"q"');
  assert.equal(decodeEntities('&#65;'), 'A');
  assert.equal(decodeEntities('plain'), 'plain');
  assert.equal(decodeEntities(null), '');
});

test('parseNasStatus parses the real 2026-10-02 bytes', () => {
  const parsed = parseNasStatus(REAL_BODY);
  assert.equal(parsed.updateTime, 'Fri Oct 2 11:46:31 2026 GMT');
  assert.equal(parsed.sections.length, 2);
  const [gdp, closures] = parsed.sections;
  assert.equal(gdp.name, 'Ground Delay Programs');
  assert.equal(gdp.items.length, 1);
  assert.equal(gdp.items[0].airport, 'BOS');
  // durations carried VERBATIM — no derived numerics
  assert.equal(gdp.items[0].fields.Reason, 'runway construction');
  assert.equal(gdp.items[0].fields.Avg, '1 hour and 5 minutes');
  assert.equal(gdp.items[0].fields.Max, '3 hours and 4 minutes');
  assert.equal(closures.name, 'Airport Closures');
  assert.equal(closures.items.length, 2);
  assert.equal(closures.items[0].airport, 'LAX');
  assert.equal(closures.items[0].fields.Start, 'May 27 at 18:26 UTC.');
  assert.equal(closures.items[0].fields.Reopen, 'May 28 at 16:00 UTC.');
  assert.ok(closures.items[0].fields.Reason.startsWith('!LAX 05/277'));
  assert.equal(closures.items[1].airport, 'PHL');
  assert.equal(countItems(parsed.sections), 3);
});

test('parseNasStatus: empty document is a quiet sky, not an error', () => {
  const parsed = parseNasStatus(QUIET_BODY);
  assert.equal(parsed.updateTime, 'Fri Oct 2 11:46:31 2026 GMT');
  assert.equal(parsed.sections.length, 0);
  assert.equal(countItems(parsed.sections), 0);
});

test('parseNasStatus: Delay_type without a _List block is skipped, not guessed', () => {
  const weird = '<Delay_type><Name>Future Thing</Name><NoList/></Delay_type>';
  assert.equal(parseNasStatus(weird).sections.length, 0);
});

test('parseNasStatus: rows without ARPT are dropped; entity-laden fields decoded', () => {
  const xml = '<Delay_type><Name>X</Name><Ground_Delay_List>'
    + '<Ground_Delay><Reason>no airport here</Reason></Ground_Delay>'
    + '<Ground_Delay><ARPT>KJFK</ARPT><Reason>wx &amp; volume</Reason></Ground_Delay>'
    + '</Ground_Delay_List></Delay_type>';
  const parsed = parseNasStatus(xml);
  assert.equal(parsed.sections[0].items.length, 1);
  assert.equal(parsed.sections[0].items[0].airport, 'KJFK');
  assert.equal(parsed.sections[0].items[0].fields.Reason, 'wx & volume');
});

test('parseNasStatus: nested markup in a field value is skipped, never half-parsed', () => {
  const xml = '<Delay_type><Name>X</Name><Airport_Closure_List>'
    + '<Airport><ARPT>KORD</ARPT><Reason>ok</Reason><Meta><Sub>deep</Sub></Meta></Airport>'
    + '</Airport_Closure_List></Delay_type>';
  const parsed = parseNasStatus(xml);
  assert.deepEqual(parsed.sections[0].items[0].fields, { Reason: 'ok' });
});

test('updateAgeMinutes parses the FAA Update_Time best-effort', () => {
  const now = Date.UTC(2026, 9, 2, 12, 0, 0);
  const age = updateAgeMinutes('Fri Oct 2 11:46:31 2026 GMT', now);
  assert.ok(age > 13 && age < 14, `expected ~13.6, got ${age}`);
  assert.equal(updateAgeMinutes('not a date', now), null);
  assert.equal(updateAgeMinutes(null, now), null);
});

test('parseQuery: default, airport filter, bad input', () => {
  assert.deepEqual(parseQuery(new URLSearchParams('')), { mode: 'all' });
  assert.deepEqual(parseQuery(new URLSearchParams('airport=')), { mode: 'all' });
  assert.deepEqual(parseQuery(new URLSearchParams('airport=kjfk')), { mode: 'airport', airport: 'KJFK' });
  assert.deepEqual(parseQuery(new URLSearchParams('airport=EGLL')), { mode: 'airport', airport: 'EGLL' });
  for (const bad of ['KJFK!!', 'TOOLONGCODE', 'K J', 'a b', '<x>']) {
    assert.throws(() => parseQuery(new URLSearchParams(`airport=${encodeURIComponent(bad)}`)), /faadelays_bad_airport/);
  }
});

test('filterByAirport scopes every section to one airport', () => {
  const parsed = parseNasStatus(REAL_BODY);
  const scoped = filterByAirport(parsed.sections, 'PHL');
  assert.equal(countItems(scoped), 1);
  assert.equal(scoped[1].items[0].airport, 'PHL');
  const empty = filterByAirport(parsed.sections, 'KJFK');
  assert.equal(countItems(empty), 0);
});

test('buildPayload: real body, all-airports mode', () => {
  const parsed = parseNasStatus(REAL_BODY);
  const nowMs = Date.UTC(2026, 9, 2, 12, 0, 0);
  const payload = buildPayload(parsed, { mode: 'all' }, false, nowMs);
  assert.equal(payload.summary.sections, 2);
  assert.equal(payload.summary.items, 3);
  assert.deepEqual(payload.summary.byType, { 'Ground Delay Programs': 1, 'Airport Closures': 2 });
  assert.deepEqual(payload.summary.airports, ['BOS', 'LAX', 'PHL']);
  assert.equal(payload.stale, false);
  assert.ok(payload.honesty.activeOnly.includes('ONLY currently-active'));
  assert.ok(payload.honesty.verbatim.includes('verbatim'));
  assert.equal(typeof payload.generatedAt, 'string');
  assert.ok(payload.updateAgeMinutes > 13 && payload.updateAgeMinutes < 14);
});

test('buildPayload: airport mode scopes summary; quiet body is honest 200 shape', () => {
  const parsed = parseNasStatus(REAL_BODY);
  const scoped = buildPayload(parsed, { mode: 'airport', airport: 'BOS' }, false);
  assert.equal(scoped.summary.items, 1);
  assert.deepEqual(scoped.summary.airports, ['BOS']);
  const quiet = buildPayload(parseNasStatus(QUIET_BODY), { mode: 'all' }, false);
  assert.equal(quiet.summary.items, 0);
  assert.deepEqual(quiet.summary.byType, {});
  assert.equal(quiet.sections.length, 0);
  assert.ok(quiet.honesty.zeroIsReal.includes('quiet sky'));
});

test('buildPayload: stale flag propagates', () => {
  const parsed = parseNasStatus(REAL_BODY);
  assert.equal(buildPayload(parsed, { mode: 'all' }, true).stale, true);
});

test('_faaDelaysInternals exposes the cache reset', () => {
  assert.equal(typeof _faaDelaysInternals.clearCaches, 'function');
  assert.equal(typeof _faaDelaysInternals.UPSTREAM_URL, 'string');
});

test('firstTag/allBlocks helpers', () => {
  assert.equal(firstTag('<A>x</A><B>y</B>', 'B'), 'y');
  assert.equal(firstTag('<A>x</A>', 'Z'), null);
  assert.deepEqual(allBlocks('<I>a</I><I>b</I>', 'I'), ['a', 'b']);
  assert.deepEqual(allBlocks('', 'I'), []);
});
