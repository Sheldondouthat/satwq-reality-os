/**
 * Surge-500 index test — AUTO-GENERATED. Validates every spec at once and
 * asserts the generated wiring (api mount + registry entry) exists.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { validateSpec } from '../../server/providers/wave10/generic.js';
import { SPECS, SPEC_IDS } from '../../server/providers/wave10/specs.mjs';

const registrySrc = readFileSync(
  new URL('../../server/pages/registry.mjs', import.meta.url), 'utf8');

test('every spec validates', () => {
  assert.ok(SPEC_IDS.length > 0, 'no specs generated');
  for (const id of SPEC_IDS) {
    assert.equal(validateSpec(SPECS[id]), true, id);
  }
});

test('no duplicate spec urls', () => {
  const urls = SPEC_IDS.map((id) => SPECS[id].url);
  assert.equal(new Set(urls).size, urls.length, 'duplicate upstream url');
});

test('every spec has an api mount and a registry entry', () => {
  for (const id of SPEC_IDS) {
    const mountUrl = new URL(`../../api/${id}.js`, import.meta.url);
    assert.ok(existsSync(mountUrl), `api/${id}.js missing`);
    assert.ok(registrySrc.includes(`name: '${id}'`), `registry entry for '${id}' missing`);
    assert.ok(registrySrc.includes(`/api/${id}`), `registry route for '${id}' missing`);
  }
});

test('every spec has a real fixture', () => {
  for (const id of SPEC_IDS) {
    const fixtureUrl = new URL(`../../server/providers/wave10/fixtures/${id}.json`, import.meta.url);
    assert.ok(existsSync(fixtureUrl), `fixture for ${id} missing`);
    const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
    assert.ok(fixture && typeof fixture === 'object', `fixture for ${id} not an object`);
  }
});
