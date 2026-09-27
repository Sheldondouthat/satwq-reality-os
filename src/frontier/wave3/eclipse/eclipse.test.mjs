import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ECLIPSE_2045,
  LIGHT_BANDS,
  evalElements,
  ringAroundPoint,
  ringRadiusForElevation,
  sampleEclipse,
  shadowSpeedKms,
  subShadowPoint,
  subsolarPointAt,
  tdtHoursToUtc,
  umbralEllipse,
  utcToTdtHours,
} from './model.js';

const ev = ECLIPSE_2045;
// Greatest eclipse: 17:42:39 TDT; t0 = 18:00 TDT.
const T_GE = -((17 * 60 + 21) / 3600);

test('evalElements reproduces the published t0 row', () => {
  const e = evalElements(ev, 0);
  assert.ok(Math.abs(e.x - 0.24066) < 1e-7);
  assert.ok(Math.abs(e.y - 0.124094) < 1e-7);
  assert.ok(Math.abs(e.mu - 88.760483 * (Math.PI / 180)) < 1e-9);
});

test('tdtHoursToUtc applies ΔT=89.1 s', () => {
  const utc = tdtHoursToUtc(ev, T_GE).toISOString();
  assert.ok(utc.startsWith('2045-08-12T17:41:0'), `utc=${utc}`);
});

test('utcToTdtHours inverts tdtHoursToUtc', () => {
  for (const t of [-2.5, T_GE, 1.75]) {
    const back = utcToTdtHours(ev, tdtHoursToUtc(ev, t));
    assert.ok(Math.abs(back - t) < 1e-9, `t=${t} back=${back}`);
  }
});

test('sub-shadow point matches NASA greatest-eclipse anchor', () => {
  const p = subShadowPoint(ev, T_GE);
  assert.ok(p, 'axis hits Earth');
  // NASA: 25.9N, 78.5W. Tolerance 1° — covers ΔT-model and rounding slack.
  assert.ok(Math.abs(p.latDeg - 25.9) < 1.0, `lat=${p.latDeg}`);
  assert.ok(Math.abs(p.lonDeg - -78.5) < 1.0, `lon=${p.lonDeg}`);
});

test('umbral ellipse matches NASA path width and sun altitude', () => {
  const el = umbralEllipse(ev, T_GE);
  assert.ok(el, 'umbral shadow exists at GE');
  // NASA: path width 255.6 km (major axis), sun altitude 77.6°.
  assert.ok(Math.abs(2 * el.semiMajorKm - 255.6) / 255.6 < 0.03,
    `major=${2 * el.semiMajorKm}`);
  assert.ok(Math.abs(el.widthKm - 255.6) / 255.6 < 0.05, `minor width=${el.widthKm}`);
  assert.ok(Math.abs(el.sunAltitudeDeg - 77.6) < 1.5, `alt=${el.sunAltitudeDeg}`);
});

test('central duration matches NASA 6m06s', () => {
  const el = umbralEllipse(ev, T_GE);
  const v = shadowSpeedKms(ev, T_GE);
  assert.ok(v && v > 0.3 && v < 1.2, `speed=${v} km/s`);
  const dur = el.widthKm / v;
  assert.ok(Math.abs(dur - 366) < 30, `duration=${dur}s`);
});

test('sampleEclipse covers the whole event with US landfall', () => {
  const { samples, tStart, tEnd } = sampleEclipse(ev, { stepMin: 10 });
  assert.ok(tEnd - tStart > 4.5, `event window ${(tEnd - tStart).toFixed(2)}h`);
  assert.ok(samples.length > 15, `axis-hit samples=${samples.length}`);
  assert.ok(tStart < T_GE && tEnd > T_GE, 'window brackets GE');
  const us = samples.filter((s) =>
    s.center.lonDeg > -130 && s.center.lonDeg < -65 &&
    s.center.latDeg > 20 && s.center.latDeg < 55);
  assert.ok(us.length > 5, `US samples=${us.length}`);
  // First US landfall should be the West Coast, last exit Florida/Atlantic.
  assert.ok(us[0].center.lonDeg < -110, `landfall lon=${us[0].center.lonDeg}`);
  assert.ok(us[us.length - 1].center.lonDeg > -90, `exit lon=${us[us.length - 1].center.lonDeg}`);
  for (const s of samples) {
    assert.ok(s.utc.startsWith('2045-08-12T'), 'UTC labels');
  }
});

test('ringRadiusForElevation maps golden/blue hour bands', () => {
  assert.equal(ringRadiusForElevation(6), 84);
  assert.equal(ringRadiusForElevation(-4), 94);
  assert.equal(ringRadiusForElevation(-6), 96);
  assert.equal(LIGHT_BANDS.length, 2);
});

test('subsolarPointAt matches solar declination and -mu', () => {
  const sub = subsolarPointAt(ev, T_GE);
  // Solar declination on 2045-08-12 ≈ +14.7°; subsolar lon ≈ -(17:41 UT) ≈ -85°.
  assert.ok(Math.abs(sub.latDeg - 14.67) < 0.5, `lat=${sub.latDeg}`);
  assert.ok(Math.abs(sub.lonDeg - -85) < 3, `lon=${sub.lonDeg}`);
});

test('ringAroundPoint draws a closed great-circle ring', () => {  const ring = ringAroundPoint(37, -95, 84, 64);
  assert.equal(ring.length, 65);
  assert.ok(Math.abs(ring[0][0] - ring[64][0]) < 1e-9, 'closed (lon)');
  assert.ok(Math.abs(ring[0][1] - ring[64][1]) < 1e-9, 'closed (lat)');
  for (const [lo, la] of ring) {
    assert.ok(la >= -90 && la <= 90 && lo >= -180 && lo <= 180);
  }
});
