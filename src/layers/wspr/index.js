import * as Cesium from 'cesium';
import { descriptorsForSnapshot, WSPR_ARC_DRAW_CAP } from './records.js';
import { arcColor, arcPositions, mapAnalystRecord, snrStyle } from './model.js';
export * from './model.js';
export * from './records.js';
export { createWsprSource } from './source.js';

/**
 * Own one WSPR propagation-arc display and its refresh lifecycle.
 * One great-circle arc per spot, transmitter → receiver (BM4 §5).
 * Default off; the layer manager only fetches while enabled.
 */
export function createWsprLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('WSPR requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _received = 0;
  let _capped = false;
  let _stale = false;
  let _degraded = false;
  let _generatedAt = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'wspr',
    name: 'WSPR Propagation Arcs',
    icon: '📡',
    source: 'wspr.live (WSPRnet mirror)',
    // The provider caches ≥3 minutes against wspr.live's ceiling;
    // refreshing faster would only re-read its cache.
    updateInterval: 180000,

    init(viewer) {
      if (_viewer) throw new Error('WSPR layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('wspr');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _received = 0;
      _capped = false;
      _stale = false;
      _degraded = false;
      _generatedAt = null;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:Wspr] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({
          signal: request.signal,
        });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const built = descriptorsForSnapshot(snapshot, {
          cap: WSPR_ARC_DRAW_CAP,
        });

        _dataSource.entities.removeAll();
        for (const arc of built.arcs) {
          _dataSource.entities.add(
            new Cesium.Entity({
              // The entity id carries the wspr.rx row id — the §7
              // join key — and properties.spotId repeats it for
              // consumers that read properties, never the id string.
              id: arc.entityId,
              polyline: {
                positions: arcPositions(arc.points),
                width: snrStyle(arc.snrDb).width,
                material: arcColor(arc.band, arc.snrDb),
                // Positions are already great-circle interpolated
                // (records.js), so Cesium must not re-arc them.
                arcType: Cesium.ArcType.NONE,
                clampToGround: false,
              },
              properties: {
                spotId: arc.spotId,
                txCall: arc.txCall,
                rxCall: arc.rxCall,
                freqMHz: arc.freqMHz,
                band: arc.band,
                snrDb: arc.snrDb,
                time: arc.time,
              },
            }),
          );
        }

        _count = built.drawn;
        _received = built.received;
        _capped = built.capped;
        // The endpoint's own stale/degraded flags govern the
        // reported state; the success payload carries neither today,
        // so both read false until the endpoint says otherwise.
        _stale = built.stale;
        _degraded = built.degraded;
        _generatedAt = built.generatedAt;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Wspr] Updated: ${_count} arcs drawn of ${_received} spots received${_capped ? ` (draw cap ${WSPR_ARC_DRAW_CAP})` : ''}`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Keep the last good arcs on the globe; the error is reported
        // through getStats, never by silently emptying the layer.
        console.warn('[Data:Wspr] Fetch error:', e);
        _lastError = e?.message || 'WSPR source unavailable';
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
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _received = 0;
      _capped = false;
      _stale = false;
      _degraded = false;
      _generatedAt = null;
      _lastUpdate = null;
      _lastError = null;
    },

    /**
     * Snapshot the drawn arcs as plain records for the analyst query
     * engine. Each record carries the wspr.rx spot id (BM4 §7 join
     * key). Returns [] while the layer is disabled or empty.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const p = entity.properties;
        result.push(
          mapAnalystRecord(
            {
              spotId: p?.spotId?.getValue(now) ?? null,
              txCall: p?.txCall?.getValue(now) ?? null,
              rxCall: p?.rxCall?.getValue(now) ?? null,
              freqMHz: p?.freqMHz?.getValue(now) ?? null,
              band: p?.band?.getValue(now) ?? null,
              snrDb: p?.snrDb?.getValue(now) ?? null,
              time: p?.time?.getValue(now) ?? null,
            },
            result.length,
          ),
        );
      }
      return result;
    },

    getStats() {
      return {
        count: _count,
        received: _received,
        capped: _capped,
        drawCap: WSPR_ARC_DRAW_CAP,
        stale: _stale,
        degraded: _degraded,
        generatedAt: _generatedAt,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
