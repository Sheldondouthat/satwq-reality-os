import assert from 'node:assert/strict';
import test from 'node:test';
import { bandClass, fmtMhz, honestyFor, transmitterSummary, plottableTransmitters, escapeHtml } from './model.js';

test('bandClass buckets frequencies', () => {
  assert.equal(bandClass(7_074_000), 'HF');
  assert.equal(bandClass(145_500_000), 'VHF');
  assert.equal(bandClass(437_100_000), 'UHF');
  assert.equal(bandClass(10_450_000_000), 'SHF+');
  assert.equal(bandClass(null), '—');
  assert.equal(bandClass(-5), '—');
});

test('fmtMhz formats compactly', () => {
  assert.equal(fmtMhz(136_658_500), '136.66 MHz');
  assert.equal(fmtMhz(7_074_000), '7.074 MHz');
  assert.equal(fmtMhz(null), '—');
  assert.equal(fmtMhz(0), '—');
});

test('honestyFor labels each dataset honestly', () => {
  assert.ok(honestyFor('callsign').includes('not live'));
  assert.ok(honestyFor('tle').includes('computed, not measured'));
  assert.ok(honestyFor('numbers').includes('NOT live telemetry'));
});

test('transmitterSummary composes mode and downlink', () => {
  assert.equal(
    transmitterSummary({ mode: 'USB', downlinkHz: { low: 136_658_500, high: 136_658_500 } }),
    'USB · 136.66 MHz',
  );
  assert.equal(transmitterSummary({}), '— · —');
});

test('plottableTransmitters keeps live rows with a downlink', () => {
  const rows = [
    { alive: true, downlinkHz: { low: 437_100_000 } },
    { alive: false, downlinkHz: { low: 437_100_000 } },
    { alive: true, downlinkHz: { low: null, high: null } },
  ];
  assert.equal(plottableTransmitters(rows).length, 1);
  assert.deepEqual(plottableTransmitters(null), []);
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<i>x</i>'), '&lt;i&gt;x&lt;/i&gt;');
});
