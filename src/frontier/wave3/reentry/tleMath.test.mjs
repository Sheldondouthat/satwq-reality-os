/**
 * tleMath tests — REAL assertions on TLE parsing + decay prediction.
 * TLE fixtures are assembled in-test with valid checksums (helper below),
 * so every propagated value is computed, not quoted.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseImpliedFloat,
  parseTleText,
  tleElements,
  predictDecay,
  decayUrgency,
  N_CRIT_REV_DAY,
  MU_KM3_S2,
  EARTH_RADIUS_KM,
} from './tleMath.js';

/** TLE checksum: sum of digits mod 10 ('-' counts 1). */
function checksum68(line68) {
  let sum = 0;
  for (const c of line68) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}

/** Build a 68-char line 1 + checksum from orbital elements. */
function makeLine1({ satnum = '25544', epochYear = '26', epochDay = '270.50000000', ndot = ' .00002174', bstar = ' 12345-6' } = {}) {
  const body =
    '1 ' + satnum.padEnd(5, ' ') + 'U ' + '98067A  ' + ' ' +
    epochYear + epochDay.padStart(12, ' ') + ' ' +
    ndot.padStart(10, ' ') + ' ' + ' 00000-0' + ' ' + bstar.padStart(8, ' ') +
    ' 0' + ' ' + ' 999';
  if (body.length !== 68) throw new Error(`line1 body ${body.length} != 68`);
  return body + checksum68(body);
}

function makeLine2({ satnum = '25544', incl = ' 51.6400', raan = '208.9163', ecc = '0006703', argp = ' 69.9862', ma = ' 25.2906', mm = '15.72125391' } = {}) {
  const body =
    '2 ' + satnum.padEnd(5, ' ') + ' ' +
    incl.padStart(8, ' ') + ' ' + raan.padStart(8, ' ') + ' ' +
    ecc.padStart(7, '0') + ' ' + argp.padStart(8, ' ') + ' ' + ma.padStart(8, ' ') +
    ' ' + mm.padStart(11, ' ') + '00001'; // rev number cols 63-67
  if (body.length !== 68) throw new Error(`line2 body ${body.length} != 68`);
  return body + checksum68(body);
}

test('N_CRIT matches a 150 km circular orbit from first principles', () => {
  const a = EARTH_RADIUS_KM + 150;
  const expected = (Math.sqrt(MU_KM3_S2 / a ** 3) * 86400) / (2 * Math.PI);
  assert.ok(Math.abs(N_CRIT_REV_DAY - expected) < 1e-12);
  assert.ok(N_CRIT_REV_DAY > 16.3 && N_CRIT_REV_DAY < 16.6); // sanity band
});

test('parseImpliedFloat decodes CelesTrak implied-decimal fields', () => {
  assert.ok(Math.abs(parseImpliedFloat(' 12345-6') - 1.2345e-7) < 1e-14);
  assert.equal(parseImpliedFloat(' 00000-0'), 0);
  assert.ok(Math.abs(parseImpliedFloat('-23456+2') - -0.23456e2) < 1e-9);
  assert.equal(parseImpliedFloat('garbage'), null);
});

test('tleElements parses a constructed TLE exactly', () => {
  const l1 = makeLine1();
  const l2 = makeLine2();
  const el = tleElements(l1, l2);
  assert.equal(el.noradId, '25544');
  assert.ok(Math.abs(el.meanMotion - 15.72125391) < 1e-8);
  assert.ok(Math.abs(el.ecc - 0.0006703) < 1e-9);
  assert.ok(Math.abs(el.inclDeg - 51.64) < 1e-9);
  assert.ok(Math.abs(el.ndot - 2 * 0.00002174) < 1e-12, 'ndot is the field doubled (TLE stores ṅ/2)');
  assert.ok(Math.abs(el.bstar - 1.2345e-7) < 1e-14);
  assert.equal(el.epochUtc, new Date(Date.UTC(2026, 0, 1) + (270.5 - 1) * 86400000).toISOString());
});

test('predictDecay rejects a healthy ISS-like orbit (no candidate)', () => {
  const el = tleElements(makeLine1(), makeLine2());
  assert.equal(predictDecay(el), null); // ~34k days out — not decaying
});

test('predictDecay flags a strongly-dragged object with honest numbers', () => {
  const l1 = makeLine1({ ndot: ' .08000000' });
  const l2 = makeLine2({ mm: '16.30000000', ecc: '0010000' });
  const el = tleElements(l1, l2);
  const pred = predictDecay(el, { maxDays: 120 });
  assert.ok(pred, 'must be a candidate');
  const expectedDays = (N_CRIT_REV_DAY - 16.3) / (2 * 0.08); // field is ṅ/2
  assert.ok(Math.abs(pred.daysToDecay - expectedDays) < 0.05, `days ${pred.daysToDecay} ≈ ${expectedDays}`);
  assert.ok(pred.perigeeKm > 150 && pred.perigeeKm < 400, `perigee ${pred.perigeeKm}`);
  assert.ok(pred.uncertaintyDays >= 0.5, 'uncertainty floor holds');
  assert.ok(Date.parse(pred.predictedDecayUtc) > Date.parse(el.epochUtc));
});

test('predictDecay rejects negative drag and high perigee', () => {
  const neg = tleElements(makeLine1({ ndot: '-.00002174' }), makeLine2());
  assert.equal(predictDecay(neg), null);
  const high = tleElements(makeLine1({ ndot: ' .08000000' }), makeLine2({ mm: '14.00000000', ecc: '0001000' }));
  assert.equal(predictDecay(high), null); // perigee ~800 km
});

test('decayUrgency thresholds', () => {
  assert.equal(decayUrgency(2), 'imminent');
  assert.equal(decayUrgency(3), 'imminent');
  assert.equal(decayUrgency(10), 'weeks');
  assert.equal(decayUrgency(60), 'watch');
  assert.equal(decayUrgency(-1), 'unknown');
});

test('parseTleText splits 3-line sets and skips junk', () => {
  const text = ['DEBRIS TEST', makeLine1(), makeLine2(), '', 'junk line', 'ANOTHER', makeLine1({ satnum: '48274' }), makeLine2({ satnum: '48274' })].join('\n');
  const sets = parseTleText(text);
  assert.equal(sets.length, 2);
  assert.equal(sets[0].name, 'DEBRIS TEST');
  assert.equal(sets[1].name, 'ANOTHER');
  assert.ok(sets[0].line1.startsWith('1 25544'));
  assert.deepEqual(parseTleText(null), []);
});
