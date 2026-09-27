/** Wave 3 Track 2c / 2.13 — /api/gdelt snapshot source (injectable fetch for tests). */
export function createGdeltSource({ fetchImpl = fetch, apiPath = '/api/gdelt' } = {}) {
  async function getSnapshot({ q, timespan } = {}) {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (timespan) params.set('timespan', String(timespan));
    const qs = params.toString();
    const res = await fetchImpl(qs ? `${apiPath}?${qs}` : apiPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`gdelt_http_${res.status}`);
    const doc = await res.json();
    if (!doc || !Array.isArray(doc.mentions)) throw new Error('gdelt_bad_shape');
    return doc;
  }
  return { getSnapshot };
}
