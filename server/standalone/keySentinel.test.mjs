import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEY_SENTINEL,
  SENTINEL_KEY_NAMES,
  isKeySentinel,
  cleanKey,
  scrubKeySentinels,
} from './keySentinel.mjs';

test('sentinel constant matches the SnapDeploy wizard value', () => {
  assert.equal(KEY_SENTINEL, 'NOT-CONFIGURED');
});

test('isKeySentinel treats blank and sentinel as absent', () => {
  assert.equal(isKeySentinel(undefined), true);
  assert.equal(isKeySentinel(null), true);
  assert.equal(isKeySentinel(''), true);
  assert.equal(isKeySentinel('   '), true);
  assert.equal(isKeySentinel('NOT-CONFIGURED'), true);
  assert.equal(isKeySentinel('  NOT-CONFIGURED  '), true);
});

test('isKeySentinel keeps real keys and near-misses', () => {
  assert.equal(isKeySentinel('abc123'), false);
  assert.equal(isKeySentinel('not-configured'), false);
  assert.equal(isKeySentinel('NOT-CONFIGURED!'), false);
  assert.equal(isKeySentinel('XNOT-CONFIGURED'), false);
});

test('cleanKey returns empty string for absent, original otherwise', () => {
  assert.equal(cleanKey(undefined), '');
  assert.equal(cleanKey('  '), '');
  assert.equal(cleanKey('NOT-CONFIGURED'), '');
  assert.equal(cleanKey('real-key-1'), 'real-key-1');
  assert.equal(cleanKey('  spaced  '), '  spaced  ');
});

test('scrubKeySentinels deletes only sentinel/blank keys', () => {
  const env = {
    AISSTREAM_API_KEY: 'NOT-CONFIGURED',
    CESIUM_ION_TOKEN: '   ',
    FIRMS_MAP_KEY: 'real-firms-key',
    GOOGLE_MAPS_API_KEY: 'NOT-CONFIGURED',
    UNRELATED: 'NOT-CONFIGURED',
  };
  const scrubbed = scrubKeySentinels(env);
  assert.deepEqual(scrubbed, [
    'AISSTREAM_API_KEY',
    'CESIUM_ION_TOKEN',
    'GOOGLE_MAPS_API_KEY',
  ]);
  assert.ok(!('AISSTREAM_API_KEY' in env));
  assert.ok(!('CESIUM_ION_TOKEN' in env));
  assert.equal(env.FIRMS_MAP_KEY, 'real-firms-key');
  assert.equal(env.UNRELATED, 'NOT-CONFIGURED');
});

test('scrubKeySentinels is idempotent and covers all nine keys', () => {
  assert.equal(SENTINEL_KEY_NAMES.length, 9);
  const env = Object.fromEntries(
    SENTINEL_KEY_NAMES.map((name) => [name, 'NOT-CONFIGURED']),
  );
  assert.equal(scrubKeySentinels(env).length, 9);
  assert.deepEqual(scrubKeySentinels(env), []);
  assert.deepEqual(Object.keys(env), []);
});
