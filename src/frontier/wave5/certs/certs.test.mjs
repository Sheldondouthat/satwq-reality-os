import assert from 'node:assert/strict';
import test from 'node:test';
import { daysLabel, expiryColor, tickerSummary } from './model.js';

test('daysLabel formats expiry horizons', () => {
  assert.equal(daysLabel(85), 'expires in 85d');
  assert.equal(daysLabel(0), 'expires today');
  assert.equal(daysLabel(-12), 'expired 12d ago');
  assert.equal(daysLabel(null), 'expiry unknown');
});

test('expiryColor grades by horizon', () => {
  assert.equal(expiryColor(-5), '#ff5a5a');
  assert.equal(expiryColor(10), '#ff8a3d');
  assert.equal(expiryColor(60), '#f5c542');
  assert.equal(expiryColor(200), '#59d98c');
  assert.equal(expiryColor(null), '#8a93a6');
});

test('tickerSummary condenses a payload with top-5 certs', () => {
  const s = tickerSummary({
    query: 'example.com',
    resultCount: 3,
    capped: false,
    certs: [
      { commonName: 'example.com', issuer: 'Sectigo', expiresInDays: 85 },
      { commonName: '*.example.com', issuer: 'Cloudflare', expiresInDays: 30 },
    ],
  });
  assert.equal(s.value, '3 certs');
  assert.equal(s.query, 'example.com');
  assert.equal(s.capped, false);
  assert.equal(s.top.length, 2);
  assert.equal(s.top[0].expiry, 'expires in 85d');
  assert.equal(s.top[1].expiry, 'expires in 30d');
});

test('tickerSummary returns null on a bad payload', () => {
  assert.equal(tickerSummary(null), null);
  assert.equal(tickerSummary({}), null);
});
