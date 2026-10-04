/**
 * Invisible Ocean (F13) — planetary ambient-RF observatory layer.
 *
 * Renders LIVE propagation arcs: TX->RX great-circle paths from volunteer
 * WSPRnet + PSK Reporter spots, colored by amateur band, fading with spot age
 * on a ~3-minute sweep. Companion "EM weather" ticker lives in panel.js.
 *
 * Deliberate non-goals (see about.js):
 *  - No strike rendering (sibling lightning layer owns impulses; we show RF
 *    *energy* context only, and only if a keyless VLF feed exists — none does
 *    at ship, so this layer is WSPR/PSK propagation + SWPC EM weather).
 *  - No message content, ever. Spots are public volunteer/broadcast metadata.
 */
import * as Cesium from 'cesium';
import {
  INVISIBLE_OCEAN_OVERLAY_SOURCE_ID,
  greatCirclePath,
  arcApexKm,
  arcSegments,
  spotAlpha,
  isSpotAlive,
  capSpots,
  bandColor,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createInvisibleOceanSource, SWPC_ENDPOINTS } from './source.js';
export { createEmWeatherPanel } from './panel.js';
export * from './about.js';

const DEG_HEIGHTS_CHUNK = 4096;

/** Defensive client-side re-validation of a proxy-normalized spot. */
function coerceSpot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const lat = [raw.txLat, raw.rxLat].map(Number);
  const lon = [raw.txLon, raw.rxLon].map(Number);
  if (lat.some((v) => !Number.isFinite(v) || Math.abs(v) > 90)) return null;
  if (lon.some((v) => !Number.isFinite(v) || Math.abs(v) > 180)) return null;
  const timeMs = Number(raw.timeMs);
  if (!Number.isFinite(timeMs) || timeMs <= 0) return null;
  const distanceKm = Number(raw.distanceKm);
  if (!Number.isFinite(distanceKm) || distanceKm < 50) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : `spot-${timeMs}`,
    provider: raw.provider === 'wsprnet' ? 'wsprnet' : 'pskreporter',
    txLat: lat[0],
    txLon: lon[0],
    rxLat: lat[1],
    rxLon: lon[1],
    freqHz: Number(raw.freqHz) || 0,
    band: typeof raw.band === 'string' ? raw.band : '?',
    color: typeof raw.color === 'string' ? raw.color : bandColor(raw.band),
    mode: typeof raw.mode === 'string' ? raw.mode : '—',
    snrDb: Number.isFinite(Number(raw.snrDb)) ? Number(raw.snrDb) : null,
    timeMs,
    txCall: typeof raw.txCall === 'string' ? raw.txCall : '—',
    rxCall: typeof raw.rxCall === 'string' ? raw.rxCall : '—',
    distanceKm,
  };
}

/** Build elevated positions for one arc: smooth hill peaking at midpoint. */
function arcPositions(spot) {
  const a = { lat: spot.txLat, lon: spot.txLon };
  const b = { lat: spot.rxLat, lon: spot.rxLon };
  const segments = arcSegments(spot.distanceKm);
  const apex = arcApexKm(spot.distanceKm);
  const flat = greatCirclePath(a, b, segments);
  const out = new Array(flat.length * 3);
  for (let i = 0; i < flat.length; i++) {
    const t = i / (flat.length - 1);
    const height = apex * Math.pow(Math.sin(Math.PI * t), 0.8) * 1000; // metres
    out[i * 3] = flat[i][0];
    out[i * 3 + 1] = flat[i][1];
    out[i * 3 + 2] = Math.max(1000, height);
  }
  return out;
}

/** Own one invisible-ocean display and its refresh lifecycle. */
export function createInvisibleOceanLayer({ source, overlayHost } = {}) {
  if (typeof source?.getPropagationSnapshot !== 'function')
    throw new TypeError('Invisible Ocean requires a propagation source');
  if (typeof source?.getEmWeatherSnapshot !== 'function')
    throw new TypeError('Invisible Ocean requires an EM-weather source');
  if (!overlayHost)
    throw new TypeError('Invisible Ocean requires an overlay host');

  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _dropped = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  let _lastEm = null;
  let _lastProviders = null;
  let _lastTimeMs = null;

  const layer = {
    id: 'invisible-ocean',
    name: 'Invisible Ocean (RF)',
    icon: '🌊',
    source: 'WSPRnet / PSK Reporter / NOAA SWPC',
    updateInterval: 180000, // ~3-minute sweep

    init(viewer) {
      if (_viewer)
        throw new Error('Invisible Ocean layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('invisible-ocean');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _dropped = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      _lastEm = null;
      _lastProviders = null;
      _lastTimeMs = null;
      overlayHost.setVisible(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID, false);
      console.log('[Data:InvisibleOcean] Initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const [prop, em] = await Promise.all([
          source.getPropagationSnapshot({ signal: request.signal }),
          source
            .getEmWeatherSnapshot({ signal: request.signal })
            .catch(() => null),
        ]);
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const now = Date.now();
        const spots = (prop.spots ?? [])
          .map(coerceSpot)
          .filter(Boolean)
          .filter((s) => isSpotAlive(s, now));
        const { spots: capped, dropped } = capSpots(spots);

        _dataSource.entities.removeAll();
        for (const spot of capped) {
          const alpha = spotAlpha(spot, now);
          if (alpha <= 0.01) continue;
          let color;
          try {
            color = Cesium.Color.fromCssColorString(spot.color).withAlpha(
              alpha * 0.9,
            );
          } catch {
            color = Cesium.Color.GRAY.withAlpha(alpha * 0.9);
          }
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `invisible-ocean:${spot.id}`,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights(
                  arcPositions(spot),
                ),
                width: 1.5,
                material: new Cesium.ColorMaterialProperty(color),
              },
              description:
                `${spot.txCall} → ${spot.rxCall} · ${spot.band} ${spot.mode}` +
                (spot.snrDb != null ? ` · SNR ${spot.snrDb} dB` : '') +
                ` · ${spot.distanceKm.toLocaleString()} km · via ${spot.provider}`,
            }),
          );
        }

        _count = capped.length;
        _dropped = dropped;
        _lastEm = em;
        _lastProviders = prop.providers ?? null;
        _lastTimeMs = prop.fetchedAt ?? now;
        _lastUpdate = now;
        _lastError =
          prop.unavailable && _count === 0
            ? prop.reason || 'Propagation feed unavailable'
            : null;
        console.log(
          `[Data:InvisibleOcean] Updated: ${_count} arcs` +
            (_lastProviders
              ? ` (psk:${_lastProviders.pskreporter ?? '?'}, wspr:${_lastProviders.wsprnet ?? '?'})`
              : ''),
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:InvisibleOcean] Fetch error:', e);
        _lastError = e?.message || 'Invisible Ocean source unavailable';
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
      overlayHost.clearSource(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(INVISIBLE_OCEAN_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _dropped = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastEm = null;
      _lastProviders = null;
      _lastTimeMs = null;
    },

    /** Panel state: EM weather + feed health for the ticker DOM. */
    getEmState() {
      return {
        em: _lastEm,
        providers: _lastProviders,
        arcCount: _count,
        dropped: _dropped,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      return [
        mapAnalystRecord(
          {
            spotCount: _count,
            providers: _lastProviders,
            em: _lastEm,
            timeMs: _lastTimeMs,
          },
          0,
        ),
      ].slice(0, maxCount);
    },

    getStats() {
      return {
        count: _count,
        dropped: _dropped,
        lastUpdate: _lastUpdate,
        error: _lastError,
        providers: _lastProviders,
        kp: _lastEm?.kp ?? null,
        solarWindKms: _lastEm?.solarWindKms ?? null,
      };
    },
  };
  return layer;
}

// Re-exported for tests without a Cesium runtime.
export { coerceSpot, arcPositions, DEG_HEIGHTS_CHUNK };
