import assert from 'node:assert/strict';
import test from 'node:test';
import { statusColor, antennaRangeLabel, antennaSummary, stationLine, plottableStations, escapeHtml } from './model.js';

test('statusColor matches the legend', () => {
  assert.equal(statusColor('observed'), '#4dd0a6');
  assert.equal(statusColor('scheduled'), '#ffb454');
  assert.equal(statusColor('idle'), '#8a93a6');
  assert.equal(statusColor('bogus'), '#55607a');
  assert.equal(statusColor(null), '#55607a');
});

test('antennaRangeLabel formats ranges', () => {
  assert.equal(antennaRangeLabel(400_000_000, 460_000_000), '400.0 MHz–460.0 MHz');
  assert.equal(antennaRangeLabel(2_400_000_000, 2_500_000_000), '2.40 GHz–2.50 GHz');
  assert.equal(antennaRangeLabel(136_658_500, 136_658_500), '136.7 MHz');
  assert.equal(antennaRangeLabel(null, null), '—');
});

test('antennaSummary composes band, range, type', () => {
  assert.equal(
    antennaSummary({ band: 'UHF', frequencyLowHz: 400_000_000, frequencyHighHz: 460_000_000, antennaTypeName: 'Cross Yagi' }),
    'UHF 400.0 MHz–460.0 MHz (Cross Yagi)',
  );
  assert.equal(antennaSummary({}), '— —');
});

test('stationLine formats observation counts', () => {
  assert.equal(stationLine({ name: 'Hackerspace.gr 1', status: 'observed', observations: 10624 }), 'Hackerspace.gr 1 · observed · 10,624 obs');
  assert.equal(stationLine({}), 'unnamed · unknown · 0 obs');
});

test('plottableStations keeps only geo rows and caps', () => {
  const rows = [{ lat: 38.0, lng: 23.7 }, { lat: null, lng: 1 }, {}];
  assert.equal(plottableStations(rows).length, 1);
  assert.deepEqual(plottableStations(undefined), []);
});

test('escapeHtml neutralizes markup in station names', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
});
