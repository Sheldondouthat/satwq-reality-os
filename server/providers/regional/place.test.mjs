import assert from 'node:assert/strict';
import test from 'node:test';
import { createNominatimSearchProvider } from './place.js';

const NOMINATIM_ROW = {
  lat: '37.3233',
  lon: '-80.7386',
  display_name: 'Pembroke, Giles County, Virginia, United States',
  name: 'Pembroke',
};

test('nominatim search: fresh result unlabeled, cached replay carries cachedAt', async () => {
  let requestCalls = 0;
  const provider = createNominatimSearchProvider({
    requestJson: async () => {
      requestCalls += 1;
      return [NOMINATIM_ROW];
    },
  });

  const first = await provider('Pembroke VA', null, {});
  assert.equal(first.status, 'OK');
  assert.equal(first.cached, undefined, 'fresh result must not claim cached');
  assert.equal(requestCalls, 1);

  const second = await provider('Pembroke VA', null, {});
  assert.equal(second.status, 'OK');
  assert.equal(second.cached, true);
  assert.ok(second.cachedAt, 'cached replay must carry cachedAt');
  const d = new Date(second.cachedAt);
  assert.ok(!Number.isNaN(d.getTime()), 'cachedAt is a valid ISO timestamp');
  assert.ok(Date.now() - d.getTime() < 60_000, 'cachedAt is serve-time fresh');
  assert.equal(requestCalls, 1, 'replay must not re-contact upstream');
  assert.deepEqual(second.results, first.results, 'replay payload identical');
});
