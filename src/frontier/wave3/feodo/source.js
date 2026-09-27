/** Wave 3 Track 2c / 2.12 — /api/feodo snapshot source (injectable fetch for tests). */
export function createFeodoSource({ fetchImpl = fetch, apiPath = '/api/feodo' } = {}) {
  async function getSnapshot() {
    const res = await fetchImpl(apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`feodo_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.entries)) throw new Error('feodo_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
