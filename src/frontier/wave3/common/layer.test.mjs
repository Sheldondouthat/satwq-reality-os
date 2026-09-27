/**
 * Wave 3 Track 2c — shared layer helper tests (src/frontier/wave3/common/layer.js).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, arcPositions } from './layer.js';

test('escapeHtml neutralizes HTML metacharacters', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('"quoted" & \'apos\''), '&quot;quoted&quot; &amp; &#39;apos&#39;');
  assert.equal(escapeHtml('plain'), 'plain');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(123), '123');
});

test('arcPositions returns segments+1 lifted positions', () => {
  const pts = arcPositions(-3.7, 40.4, 139.7, 35.7, 600000, 8);
  assert.equal(pts.length, 9);
  for (const p of pts) assert.ok(Number.isFinite(p.x + p.y + p.z));
});
