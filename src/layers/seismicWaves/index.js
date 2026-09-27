/**
 * F3 — Seismic wavefronts layer.
 *
 * Renders live P-wave (~8 km/s) and S-wave (~4.5 km/s) expanding rings from
 * the N most recent mag-4.5+ quakes as Cesium ellipses. Ring radii are
 * `Cesium.CallbackProperty`s driven by each quake's frozen origin time, so
 * the fronts grow smoothly on the globe with no per-frame re-render.
 * Quakes older than the TTL (30 min) auto-expire on the next sweep.
 * Toggleable via enable()/disable() like the other overlay layers.
 */
import * as Cesium from 'cesium';
import { createUsgsWavefrontSource } from './source.js';
import {
  P_WAVE_KM_S,
  S_WAVE_KM_S,
  WAVEFRONT_TTL_MS,
  WAVEFRONT_QUAKE_LIMIT,
  WAVEFRONT_MIN_MAG,
  wavefrontRadii,
  isWavefrontExpired,
  wavefrontAlpha,
  pickSignificantQuakes,
} from './model.js';

export * from './model.js';
export { createUsgsWavefrontSource } from './source.js';

const P_COLOR = Cesium.Color.CYAN;
const S_COLOR = Cesium.Color.ORANGE;
const EPICENTER_COLOR = Cesium.Color.RED;
const UPDATE_INTERVAL_MS = 30000;

export function createSeismicWavesLayer({ source, overlayHost } = {}) {
  const quakeSource = source || createUsgsWavefrontSource();
  if (typeof quakeSource.getSnapshot !== 'function')
    throw new TypeError('SeismicWaves requires a snapshot source');
  // overlayHost is optional: the rings render without it; labels degrade off.
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _quakes = [];
  let _lastUpdate = null;
  let _lastError = null;

  /** Radius in meters at render time, from the quake's origin epoch. */
  function radiusProperty(originTimeMs, kmPerSec) {
    return new Cesium.CallbackProperty(() => {
      const { pKm, sKm } = wavefrontRadii(
        originTimeMs,
        Date.now(),
        WAVEFRONT_TTL_MS,
      );
      const km = kmPerSec === P_WAVE_KM_S ? pKm : sKm;
      return Math.max(km * 1000, 1);
    }, false);
  }

  function renderQuakes(quakes) {
    _dataSource.entities.removeAll();
    const nowMs = Date.now();
    for (const q of quakes) {
      const center = Cesium.Cartesian3.fromDegrees(q.lon, q.lat);
      const { ageSec } = wavefrontRadii(q.originTimeMs, nowMs, WAVEFRONT_TTL_MS);
      const alpha = wavefrontAlpha(ageSec);
      const outlineWidth = 2;

      _dataSource.entities.add(
        new Cesium.Entity({
          id: `sw:${q.id}:epi`,
          position: center,
          point: {
            pixelSize: Math.min(14, 6 + q.mag * 1.2),
            color: EPICENTER_COLOR.withAlpha(Math.min(1, alpha + 0.3)),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.8),
            outlineWidth: 1,
          },
          label: {
            text: `M${q.mag.toFixed(1)}${q.place ? ` ${q.place}` : ''}`,
            font: '11px system-ui, sans-serif',
            fillColor: Cesium.Color.WHITE.withAlpha(0.9),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );

      for (const [kind, color, speed] of [
        ['p', P_COLOR, P_WAVE_KM_S],
        ['s', S_COLOR, S_WAVE_KM_S],
      ]) {
        const radius = radiusProperty(q.originTimeMs, speed);
        _dataSource.entities.add(
          new Cesium.Entity({
            id: `sw:${q.id}:${kind}`,
            position: center,
            ellipse: {
              semiMajorAxis: radius,
              semiMinorAxis: radius,
              material: color.withAlpha(0.02),
              outline: true,
              outlineColor: color.withAlpha(alpha),
              outlineWidth,
            },
          }),
        );
      }
    }

    if (overlayHost && typeof overlayHost.setEntries === 'function') {
      overlayHost.setEntries(
        'seismic-waves',
        quakes.map((q) => ({
          id: `sw:${q.id}`,
          position: Cesium.Cartesian3.fromDegrees(q.lon, q.lat),
          variant: 'label',
          title: `M${q.mag.toFixed(1)} wavefront`,
          subtitle: q.place || 'USGS 4.5+',
          accent: '#ff5a5a',
        })),
        { cohortLimit: WAVEFRONT_QUAKE_LIMIT, moving: false },
      );
    }
  }

  const layer = {
    id: 'seismic-waves',
    name: 'Seismic Wavefronts',
    icon: '🌊',
    source: 'USGS',
    updateInterval: UPDATE_INTERVAL_MS,

    init(viewer) {
      if (_viewer) throw new Error('SeismicWaves layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('seismic-waves');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _enabled = false;
      _quakes = [];
      _lastUpdate = null;
      _lastError = null;
      overlayHost?.setVisible?.('seismic-waves', false);
      console.log('[Data:SeismicWaves] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost?.setVisible?.('seismic-waves', true);
      void layer.update(_viewer);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost?.clearSource?.('seismic-waves');
      overlayHost?.setVisible?.('seismic-waves', false);
    },

    async update(viewer = _viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await quakeSource.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        const nowMs = Date.now();
        const live = pickSignificantQuakes(rows, {
          limit: WAVEFRONT_QUAKE_LIMIT,
          minMag: WAVEFRONT_MIN_MAG,
        }).filter((q) => !isWavefrontExpired(q.originTimeMs, nowMs, WAVEFRONT_TTL_MS));
        _quakes = live;
        renderQuakes(live);
        _lastUpdate = nowMs;
        _lastError = null;
        console.log(`[Data:SeismicWaves] Updated: ${live.length} live wavefronts`);
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:SeismicWaves] Fetch error:', e);
        _lastError = e?.message || 'USGS source unavailable';
        // Degrade honestly: keep rendering already-drawn rings; they keep
        // growing via CallbackProperty and expire on the next good sweep.
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost?.clearSource?.('seismic-waves');
      overlayHost?.setVisible?.('seismic-waves', false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _quakes = [];
      _lastUpdate = null;
      _lastError = null;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const nowMs = Date.now();
      return _quakes.slice(0, maxCount).map((q) => {
        const { ageSec, pKm, sKm } = wavefrontRadii(q.originTimeMs, nowMs, WAVEFRONT_TTL_MS);
        return {
          id: `seismic-wave-${q.id}`,
          type: 'seismic-wavefront',
          mag: q.mag,
          place: q.place,
          originTimeMs: q.originTimeMs,
          ageSec: Math.round(ageSec),
          pKm: Math.round(pKm),
          sKm: Math.round(sKm),
        };
      });
    },

    getStats() {
      return {
        count: _quakes.length,
        lastUpdate: _lastUpdate,
        error: _lastError,
        quakes: _quakes.map((q) => ({ id: q.id, mag: q.mag })),
      };
    },
  };
  return layer;
}
