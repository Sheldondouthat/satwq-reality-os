/**
 * Wave 3 Track 2c / 2.13 — GDELT tests.
 * Fixture is a real v1 gkg_geojson feature (query=earthquake&timespan=60, 2026-09-27).
 * Key finding baked in: LOWERCASE query/timespan params; uppercase returns empty.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGdeltFeature, parseGdeltGeojson } from '../../../../server/providers/wave3/gdelt.js';
import { clusterMentions, bubbleSize, toneColorCss } from './model.js';
import { createGdeltSource } from './source.js';

const REAL_FEATURE = {
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-3.6833, 40.4] },
  properties: {
    urlpubtimedate: '2026-09-27T05:00:00Z',
    name: 'Madrid, Madrid, Spain',
    urltone: -4.37,
    url: 'https://www.mediafax.ro/stirile-zilei/protest-23814818',
    mentionedthemes: ';SECURITY_SERVICES;TAX_FNCACT_POLICE;',
  },
};

test('normalizeGdeltFeature parses the real v1 feature shape', () => {
  const m = normalizeGdeltFeature(REAL_FEATURE);
  assert.equal(m.lon, -3.683);
  assert.equal(m.lat, 40.4);
  assert.equal(m.name, 'Madrid, Madrid, Spain');
  assert.equal(m.tone, -4.37);
  assert.ok(m.url.startsWith('https://www.mediafax.ro/'));
  assert.ok(m.themes.includes('SECURITY_SERVICES'));
  assert.equal(m.publishedAt, '2026-09-27T05:00:00Z');
});

test('normalizeGdeltFeature rejects bad geometry', () => {
  assert.equal(normalizeGdeltFeature({ geometry: null }), null);
  assert.equal(
    normalizeGdeltFeature({ geometry: { coordinates: [999, 0] } }),
    null,
  );
});

test('normalizeGdeltFeature only allows http(s) article URLs', () => {
  const withUrl = (url) =>
    normalizeGdeltFeature({
      geometry: { coordinates: [0, 0] },
      properties: { url },
    }).url;
  assert.equal(withUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(withUrl('http://example.com/a'), 'http://example.com/a');
  assert.equal(withUrl('javascript:alert(1)'), null);
  assert.equal(withUrl('data:text/html,<h1>x</h1>'), null);
  assert.equal(withUrl('https://example.com/"onmouseover="x'), 'https://example.com/"onmouseover="x');
});

test('parseGdeltGeojson caps and skips junk', () => {
  const doc = {
    type: 'FeatureCollection',
    features: [REAL_FEATURE, { type: 'Feature' }, REAL_FEATURE],
  };
  const out = parseGdeltGeojson(JSON.stringify(doc));
  assert.equal(out.length, 2);
  assert.deepEqual(parseGdeltGeojson('{"type":"FeatureCollection","features":[]}'), []);
});

test('clusterMentions groups nearby mentions and averages tone', () => {
  const mentions = [
    { lon: -3.68, lat: 40.4, tone: -4, name: 'Madrid', url: 'u1' },
    { lon: -3.7, lat: 40.42, tone: -6, name: 'Madrid', url: 'u1' }, // same cell
    { lon: 139.7, lat: 35.7, tone: 3, name: 'Tokyo', url: 'u2' },
  ];
  const clusters = clusterMentions(mentions);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 2);
  assert.equal(clusters[0].avgTone, -5);
  assert.deepEqual(clusters[0].names, ['Madrid']); // deduped
  assert.equal(clusters[1].avgTone, 3);
});

test('tone colors and bubble sizes behave', () => {
  assert.equal(toneColorCss(-4.37), '#ef5350');
  assert.equal(toneColorCss(5), '#66bb6a');
  assert.equal(toneColorCss(0), '#ffd54f');
  assert.equal(toneColorCss(null), '#ffd54f');
  assert.ok(bubbleSize(100) > bubbleSize(1));
});

test('createGdeltSource forwards q/timespan and validates shape', async () => {
  let seenUrl = '';
  const src = createGdeltSource({
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, json: async () => ({ mentions: [] }) };
    },
  });
  await src.getSnapshot({ q: 'earthquake', timespan: 60 });
  assert.ok(seenUrl.includes('q=earthquake') && seenUrl.includes('timespan=60'), seenUrl);
  const bad = createGdeltSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /gdelt_bad_shape/);
});
