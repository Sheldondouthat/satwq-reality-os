/** Wave 3 Track 2c / 2.17 — /api/aishub snapshot source (injectable fetch for tests). */
export function createAishubSource({
  fetchImpl = fetch,
  apiPath = '/api/aishub',
} = {}) {
  async function getSnapshot() {
    const res = await fetchImpl(apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`aishub_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.stations))
      throw new Error('aishub_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
