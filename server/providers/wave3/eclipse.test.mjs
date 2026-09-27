import assert from 'node:assert/strict';
import test from 'node:test';
import { ECLIPSE_ROUTE, describeEclipse, eclipseProxy } from './eclipse.js';

test('describeEclipse returns the 2045 rehearsal document', () => {
  const doc = describeEclipse('2045', 10);
  assert.equal(doc.event, '2045');
  assert.equal(doc.saros, 136);
  assert.ok(doc.attribution.includes('Espenak'), 'attributes Espenak/NASA');
  assert.ok(doc.samples.length > 15);
  assert.ok(doc.honesty.includes('rehearsal model'));
  assert.equal(doc.lightBands.length, 2);
  // US passage: California landfall to Bahamas exit.
  assert.ok(doc.usPassage, 'usPassage present');
  assert.ok(doc.usPassage.firstUtc < doc.greatestEclipseUtc, 'landfall before GE');
  assert.ok(doc.usPassage.lastUtc > doc.greatestEclipseUtc, 'exit after GE');
  assert.ok(doc.usPassage.landfall.lon < -110, `landfall lon=${doc.usPassage.landfall.lon}`);
});

test('describeEclipse samples carry ellipse geometry', () => {
  const doc = describeEclipse('2045', 30);
  const ge = doc.samples.reduce((a, b) =>
    Math.abs(new Date(a.utc) - new Date(doc.greatestEclipseUtc)) <
    Math.abs(new Date(b.utc) - new Date(doc.greatestEclipseUtc)) ? a : b);
  assert.ok(Math.abs(ge.widthKm - 255.6) / 255.6 < 0.05, `width=${ge.widthKm}`);
  assert.ok(Math.abs(ge.durationSec - 366) < 40, `duration=${ge.durationSec}`);
  assert.ok(ge.sunAltitudeDeg > 70 && ge.sunAltitudeDeg < 85);
});

test('describeEclipse rejects unknown events', () => {
  assert.equal(describeEclipse('1999', 5), null);
});

test('eclipseProxy serves 200 and 404s unknown events', async () => {
  const handlers = new Map();
  eclipseProxy().configureServer({ middlewares: { use(r, h) { handlers.set(r, h); } } });
  assert.ok(handlers.has(ECLIPSE_ROUTE));
  const get = (url) => new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(s) { this.status = s; },
      end(b) { resolve({ status: this.status, body: JSON.parse(b) }); },
    };
    handlers.get(ECLIPSE_ROUTE)({ method: 'GET', url }, res);
  });
  const ok = await get('/?event=2045&stepMin=30');
  assert.equal(ok.status, 200);
  assert.ok(ok.body.samples.length > 5);
  const bad = await get('/?event=1999');
  assert.equal(bad.status, 404);
  assert.equal(bad.body.error, 'unknown_eclipse_event');
});
