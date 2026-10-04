/** Wave 3 Track 2c / 2.15 — /api/eibi snapshot source (injectable fetch for tests). */
export function createEibiSource({
  fetchImpl = fetch,
  apiPath = '/api/eibi',
} = {}) {
  async function getSnapshot() {
    const res = await fetchImpl(apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`eibi_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.onAir)) throw new Error('eibi_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
