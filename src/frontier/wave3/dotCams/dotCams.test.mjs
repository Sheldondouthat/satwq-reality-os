import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineKm, nearestCams, weatherCamStillUrl } from './model.js';

const CAMS = [
  { id: 'ca-1', lat: 38.48, lon: -121.51, imageUrl: 'https://cwwp2.dot.ca.gov/a.jpg' },
  { id: 'ia-1', lat: 41.68, lon: -91.91, imageUrl: 'https://atmsqf.iowadot.gov/b.jpeg' },
  { id: 'ca-2', lat: 34.05, lon: -118.24, imageUrl: 'https://cwwp2.dot.ca.gov/c.jpg' },
];

test('haversineKm: Sacramento to Los Angeles ≈ 580 km', () => {
  const d = haversineKm(38.48, -121.51, 34.05, -118.24);
  assert.ok(d > 540 && d < 620, `got ${d}`);
  assert.equal(haversineKm(0, 0, 0, 0), 0);
});

test('nearestCams sorts by distance and caps at n', () => {
  const near = nearestCams(CAMS, 38.5, -121.5, 2);
  assert.equal(near.length, 2);
  assert.equal(near[0].id, 'ca-1');
  assert.ok(near[0].distKm < near[1].distKm);
  assert.ok(near.every((c) => Number.isFinite(c.distKm)));
});

test('nearestCams drops cameras without coords', () => {
  const list = nearestCams([{ id: 'x' }, ...CAMS], 38.5, -121.5, 10);
  assert.ok(list.every((c) => c.id !== 'x'));
  assert.deepEqual(nearestCams(null, 0, 0), []);
});

test('weatherCamStillUrl builds the allow-listed redirect URL', () => {
  assert.equal(
    weatherCamStillUrl(CAMS[0]),
    '/api/dot-cams/image?u=' + encodeURIComponent('https://cwwp2.dot.ca.gov/a.jpg'),
  );
  assert.equal(weatherCamStillUrl({}), null);
  assert.equal(weatherCamStillUrl(null), null);
});
