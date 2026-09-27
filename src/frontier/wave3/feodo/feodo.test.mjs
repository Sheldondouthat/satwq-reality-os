/**
 * Wave 3 Track 2c / 2.12 — Feodo Tracker tests.
 * Fixtures are real rows from feodotracker.abuse.ch/downloads/ipblocklist.json (2026-09-27).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFeodoRow, parseFeodoList } from '../../../../server/providers/wave3/feodo.js';
import { countryMarkers, markerSize, markerColorCss } from './model.js';
import { createFeodoSource } from './source.js';
import { centroidFor } from '../common/geo.js';

const REAL_ROWS = [
  { ip_address: '162.243.103.246', port: 8080, status: 'offline', hostname: null, as_number: 14061, as_name: 'DIGITALOCEAN-ASN', country: 'US', first_seen: '2022-06-04 21:24:53', last_online: '2026-03-07', malware: 'Emotet' },
  { ip_address: '50.16.16.211', port: 443, status: 'online', hostname: 'ec2-50-16-16-211.compute-1.amazonaws.com', as_number: 14618, as_name: 'AMAZON-AES', country: 'US', first_seen: '2025-12-30 13:54:53', last_online: '2026-03-12', malware: 'QakBot' },
  { ip_address: 'not-an-ip', port: 443, status: 'online', country: 'GB', malware: 'X' },
];

test('normalizeFeodoRow keeps real rows, rejects bad IPs', () => {
  const a = normalizeFeodoRow(REAL_ROWS[0]);
  assert.equal(a.ip, '162.243.103.246');
  assert.equal(a.status, 'offline');
  assert.equal(a.country, 'US');
  assert.equal(a.malware, 'Emotet');
  assert.equal(a.asNumber, 14061);
  const b = normalizeFeodoRow(REAL_ROWS[1]);
  assert.equal(b.status, 'online');
  assert.equal(normalizeFeodoRow(REAL_ROWS[2]), null);
  assert.equal(normalizeFeodoRow(null), null);
});

test('parseFeodoList parses the real blocklist array shape', () => {
  const entries = parseFeodoList(JSON.stringify(REAL_ROWS));
  assert.equal(entries.length, 2);
  assert.throws(() => parseFeodoList('{"threat":[]}'), /feodo_not_array/);
});

test('countryMarkers places real countries at real centroids', () => {
  const entries = parseFeodoList(JSON.stringify(REAL_ROWS));
  const byCountry = { US: 2, XX: 5 }; // XX is not a country -> unplotted
  const markers = countryMarkers(byCountry, entries);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].iso, 'US');
  assert.deepEqual([markers[0].lon, markers[0].lat], centroidFor('US'));
  assert.equal(markers[0].count, 2);
  assert.equal(markers[0].online, 1);
  assert.deepEqual(markers[0].malware[0], ['Emotet', 1]);
});

test('marker color/size behave', () => {
  assert.equal(markerColorCss(1), '#ef5350');
  assert.equal(markerColorCss(0), '#ffb454');
  assert.ok(markerSize(100) > markerSize(1));
});

test('createFeodoSource validates the /api/feodo shape', async () => {
  const ok = createFeodoSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ entries: [], byCountry: {} }) }),
  });
  assert.deepEqual((await ok.getSnapshot()).entries, []);
  const bad = createFeodoSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /feodo_bad_shape/);
});
