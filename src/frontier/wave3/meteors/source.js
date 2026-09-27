/** Wave 3 Track 2c / 2.14 — /api/meteors snapshot source (injectable fetch for tests). */
export function createMeteorsSource({ fetchImpl = fetch, apiPath = '/api/meteors' } = {}) {
  async function getSnapshot() {
    const res = await fetchImpl(apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`meteors_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.meteors)) throw new Error('meteors_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
