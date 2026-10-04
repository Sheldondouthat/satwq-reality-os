/** Wave 3 Track 2c / 2.11 — /api/ripestat snapshot source (injectable fetch for tests). */
export function createRipestatSource({
  fetchImpl = fetch,
  apiPath = '/api/ripestat',
} = {}) {
  async function getSnapshot() {
    const res = await fetchImpl(apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ripestat_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.prefixes))
      throw new Error('ripestat_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
