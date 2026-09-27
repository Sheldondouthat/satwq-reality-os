import assert from 'node:assert/strict';
import test from 'node:test';
import { severityForQuake, buoyStatusLabel } from './index.js';

test('severityForQuake: active tsunami alert is highest severity', () => {
  assert.equal(
    severityForQuake({ mag: 6.5, buoys: [], tsunamiAlerts: [{ event: 'Tsunami Advisory' }] }),
    'tsunami-alert',
  );
});

test('severityForQuake: M7+ couples even with no alerts', () => {
  assert.equal(severityForQuake({ mag: 7.1, buoys: [], tsunamiAlerts: [] }), 'coupled');
});

test('severityForQuake: live buoys couple', () => {
  assert.equal(
    severityForQuake({ mag: 6.5, buoys: [{ status: 'live' }], tsunamiAlerts: [] }),
    'coupled',
  );
});

test('severityForQuake: dead quake with no buoys is quiet', () => {
  assert.equal(severityForQuake({ mag: 6.5, buoys: [], tsunamiAlerts: [] }), 'quiet');
  assert.equal(severityForQuake(null), 'quiet');
});

test('buoyStatusLabel: live buoy shows column + 3h change', () => {
  const label = buoyStatusLabel({ status: 'live', waterColumnM: 5432.1, change3hM: -0.02 });
  assert.match(label, /5432\.10/);
  assert.match(label, /-0\.02 m\/3h/);
});

test('buoyStatusLabel: no_reading and unreachable degrade honestly', () => {
  assert.equal(buoyStatusLabel({ status: 'no_reading' }), 'no reading');
  assert.equal(buoyStatusLabel({ status: 'unreachable' }), 'unreachable');
  assert.equal(buoyStatusLabel(null), '—');
});
