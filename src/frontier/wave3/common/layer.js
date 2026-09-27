/**
 * Wave 3 Track 2c — shared Cesium layer mount for polling API sources.
 *
 * mountPollingLayer({ name, apiPath, intervalMs, render, onError })
 *   -> init({ viewer } = {}) -> { enable, disable, destroy, refresh } | null
 *
 * Fail-soft: init never throws to the caller (returns null on setup failure);
 * per-refresh failures are logged and keep the previous rendering.
 * No node:* imports — browser bundle only.
 */
import * as Cesium from 'cesium';

/**
 * Escape an upstream string for interpolation into Cesium entity-description
 * HTML. Upstream feeds (GDELT names/URLs, Feodo malware families, EiBi
 * station names, AISHub locations) are untrusted text — never inject them
 * raw into description HTML.
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Great-circle-ish arc positions between two lon/lat points, peaked at heightM. */
export function arcPositions(lon1, lat1, lon2, lat2, heightM = 600000, segments = 48) {
  const start = Cesium.Cartesian3.fromDegrees(lon1, lat1, 0);
  const end = Cesium.Cartesian3.fromDegrees(lon2, lat2, 0);
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = new Cesium.Cartesian3();
    Cesium.Cartesian3.lerp(start, end, t, p);
    const lift = Math.sin(Math.PI * t) * heightM;
    const carto = Cesium.Cartographic.fromCartesian(p);
    pts.push(Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, lift));
  }
  return pts;
}

export function mountPollingLayer({ name, apiPath, intervalMs, render, query = '' }) {
  if (!name || !apiPath || typeof render !== 'function') {
    throw new TypeError('mountPollingLayer requires name, apiPath, render');
  }

  function init({ viewer } = {}) {
    if (!viewer) return null;
    let dataSource = null;
    let timer = null;
    let enabled = false;
    let seq = 0;

    async function refresh() {
      const mine = ++seq;
      let data = null;
      try {
        const res = await fetch(`${apiPath}${query}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`http_${res.status}`);
        data = await res.json();
      } catch (error) {
        console.warn(`[wave3:${name}] refresh failed:`, error?.message || error);
        return;
      }
      if (mine !== seq || !enabled || !dataSource) return;
      try {
        render({ viewer, dataSource, data, Cesium });
      } catch (error) {
        console.warn(`[wave3:${name}] render failed:`, error?.message || error);
      }
    }

    function enable() {
      if (enabled) return;
      enabled = true;
      dataSource = new Cesium.CustomDataSource(name);
      viewer.dataSources.add(dataSource);
      refresh();
      timer = setInterval(refresh, intervalMs);
    }

    function disable() {
      enabled = false;
      seq++;
      if (timer) { clearInterval(timer); timer = null; }
      if (dataSource) {
        try { viewer.dataSources.remove(dataSource, true); } catch {}
        dataSource = null;
      }
    }

    try {
      return { enable, disable, refresh, destroy: disable };
    } catch (error) {
      console.warn(`[wave3:${name}] init failed:`, error?.message || error);
      return null;
    }
  }

  return { init };
}
