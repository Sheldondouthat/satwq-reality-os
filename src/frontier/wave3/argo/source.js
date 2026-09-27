/**
 * Argo float data client (browser side).
 *
 * Fetches the normalized Argo float constellation from the server proxy at
 * /api/argo (the Ifremer ERDDAP queries are aggregated server-side so the
 * browser gets one compact JSON). Pure data plumbing — no DOM, no Cesium.
 * The ocean-twin UX is owned by worker W10; this module only moves data.
 *
 * fetchImpl is injectable for tests. All failures are fail-soft: refresh()
 * resolves to { ok:false, reason } and the last good snapshot is kept.
 */

const DEFAULT_REFRESH_MS = 30 * 60 * 1000;

export function createArgoSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  proxyBase = '/api/argo',
  refreshMs = DEFAULT_REFRESH_MS,
} = {}) {
  let latest = null;
  let lastError = null;
  let timer = null;
  const listeners = new Set();

  function notify(snapshot) {
    for (const fn of listeners) {
      try {
        fn(snapshot);
      } catch {
        /* listener errors never break the loop */
      }
    }
  }

  async function refresh() {
    try {
      const response = await fetchImpl(proxyBase);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      latest = payload;
      lastError = null;
      notify(latest);
      return { ok: true, snapshot: latest };
    } catch (error) {
      lastError = error?.message || String(error);
      return { ok: false, reason: lastError, snapshot: latest };
    }
  }

  function start(onData) {
    if (typeof onData === 'function') listeners.add(onData);
    if (timer) return () => stop();
    refresh();
    timer = setInterval(refresh, refreshMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => stop();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    listeners.clear();
  }

  function getSnapshot() {
    return latest;
  }

  function getLastError() {
    return lastError;
  }

  return { refresh, start, stop, getSnapshot, getLastError };
}
