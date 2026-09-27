/**
 * lightning/index.js — F4 lightning "nervous system" layer.
 *
 * Lifecycle matches the other point layers (aurora, meteors):
 * createLightningLayer({ source, overlayHost, now, onFlash }) →
 * { init, enable, disable, update, destroy, getAnalystRecords, getStats }.
 *
 * Runtime behavior: strike impulses are fetched from `source.getStrikes()`
 * (radar-modeled by default — see source.js), filtered to the night
 * hemisphere (flashes only read against dark terrain), and ignited as
 * Cesium point entities that flash and decay over STRIKE_TTL_MS (~4 s).
 * A spawn timer keeps the sky flickering between catalog updates; a decay
 * timer fades each flash's alpha and removes dead entities.
 *
 * Per-strike overlay entries are deliberately skipped (strike churn would
 * thrash the overlay host); overlayHost is used only for source-level
 * visibility flags, like the other layers.
 *
 * DATA HONESTY: strikes carry modeled:true end-to-end. The HUD name and the
 * analyst records say "modeled" — never "detected".
 */
import * as Cesium from 'cesium';
import {
  LIGHTNING_OVERLAY_SOURCE_ID,
  STRIKE_TTL_MS,
  MAX_ACTIVE_STRIKES,
  strikeFlashColor,
  isNightSide,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export {
  createRadarModeledLightningSource,
  createBlitzortungSource,
  cellsFromTileImage,
  decodeTileImageBrowser,
  DEFAULT_RADAR_TILES,
  BLITZORTUNG_UPGRADE_NOTES,
} from './source.js';

const SPAWN_INTERVAL_MS = 900;
const DECAY_TICK_MS = 250;
const SPAWN_PER_TICK = 6;

export function createLightningLayer({
  source,
  overlayHost,
  now = () => new Date(),
  onFlash = null,
} = {}) {
  if (typeof source?.getStrikes !== 'function')
    throw new TypeError('Lightning requires a strike source (getStrikes)');
  if (!overlayHost) throw new TypeError('Lightning requires an overlay host');

  let _viewer = null;
  let _dataSource = null;
  let _enabled = false;
  let _spawnTimer = null;
  let _decayTimer = null;
  let _active = new Map(); // entityId -> { entity, bornAtMs, intensity }
  let _lastUpdate = null;
  let _lastError = null;
  let _cellCount = 0;
  let _spawnedTotal = 0;

  const stopTimers = () => {
    if (_spawnTimer) clearInterval(_spawnTimer);
    if (_decayTimer) clearInterval(_decayTimer);
    _spawnTimer = null;
    _decayTimer = null;
  };

  const removeStrike = (id) => {
    const rec = _active.get(id);
    if (!rec) return;
    _active.delete(id);
    try {
      if (_dataSource) _dataSource.entities.remove(rec.entity);
    } catch {
      /* entity already gone */
    }
  };

  /** Fade every live flash by its age; retire the dead. */
  const decayTick = () => {
    if (!_enabled || !_dataSource) return;
    const t = now().getTime();
    for (const [id, rec] of _active) {
      const { r, g, b, alpha } = strikeFlashColor(
        rec.intensity,
        t - rec.bornAtMs,
        STRIKE_TTL_MS,
      );
      if (alpha <= 0) {
        removeStrike(id);
        continue;
      }
      try {
        rec.entity.point.color = new Cesium.Color(r, g, b, alpha);
      } catch {
        removeStrike(id);
      }
    }
  };

  /** Ignite one strike impulse as a flashing point entity. */
  const ignite = (strike) => {
    if (!strike || _active.size >= MAX_ACTIVE_STRIKES) return false;
    const t = now().getTime();
    const { r, g, b } = strikeFlashColor(strike.intensity ?? 0.5, 0);
    const position = Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat);
    const size = 5 + 7 * Math.min(1, Math.max(0, strike.intensity ?? 0.5));
    const entity = new Cesium.Entity({
      id: strike.id,
      position,
      point: {
        pixelSize: size,
        color: new Cesium.Color(r, g, b, 1),
        outlineColor: new Cesium.Color(1, 1, 1, 0.9),
        outlineWidth: 1,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(1.0e6, 1.0, 8.0e6, 0.4),
      },
      properties: {
        intensity: strike.intensity ?? null,
        modeled: true,
        cellId: strike.cellId ?? null,
      },
    });
    try {
      _dataSource.entities.add(entity);
    } catch {
      return false;
    }
    _active.set(strike.id, {
      entity,
      bornAtMs: t,
      intensity: strike.intensity ?? 0.5,
      lat: strike.lat,
      lon: strike.lon,
    });
    _spawnedTotal += 1;
    if (typeof onFlash === 'function') {
      try {
        onFlash({ lat: strike.lat, lon: strike.lon, intensity: strike.intensity ?? 0.5 });
      } catch {
        /* sonification hook must never break rendering */
      }
    }
    return true;
  };

  /** Pull a fresh impulse batch and ignite the night-side subset. */
  const spawnBatch = async () => {
    if (!_enabled || !_dataSource) return;
    let strikes;
    try {
      strikes = await source.getStrikes();
    } catch (e) {
      _lastError = e?.message ?? String(e);
      return;
    }
    if (!_enabled || !_dataSource) return;
    const date = now();
    let ignited = 0;
    for (const s of strikes ?? []) {
      if (ignited >= SPAWN_PER_TICK) break;
      if (!isNightSide(s.lat, s.lon, date)) continue; // night-side only
      if (_active.has(s.id)) continue;
      if (ignite(s)) ignited += 1;
    }
    if (typeof source.getCachedCells === 'function') {
      try {
        _cellCount = source.getCachedCells().length;
      } catch {
        /* diagnostics only */
      }
    }
    _lastError = null;
  };

  const layer = {
    id: 'lightning',
    name: 'Lightning (modeled)',
    icon: '⚡',
    source: 'Modeled from RainViewer radar',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Lightning layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('lightning');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _active = new Map();
      _lastUpdate = null;
      _lastError = null;
      _cellCount = 0;
      _spawnedTotal = 0;
      _enabled = false;
      overlayHost.setVisible(LIGHTNING_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Lightning] Initialized (radar-modeled)');
    },

    enable(viewer) {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(LIGHTNING_OVERLAY_SOURCE_ID, true);
      stopTimers();
      _spawnTimer = setInterval(() => {
        spawnBatch().catch(() => {});
      }, SPAWN_INTERVAL_MS);
      _decayTimer = setInterval(decayTick, DECAY_TICK_MS);
      spawnBatch().catch(() => {});
    },

    disable(viewer) {
      stopTimers();
      _enabled = false;
      _active.clear();
      if (_dataSource) {
        _dataSource.entities.removeAll();
        _dataSource.show = false;
      }
      overlayHost.clearSource(LIGHTNING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(LIGHTNING_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      try {
        await spawnBatch();
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Lightning] Updated: ${_active.size} live flashes, ${_cellCount} candidate cells`,
        );
        return true;
      } catch (e) {
        _lastError = e?.message ?? String(e);
        console.warn('[Data:Lightning] Update error:', e);
        return false;
      }
    },

    destroy(viewer = _viewer) {
      stopTimers();
      _enabled = false;
      _active.clear();
      overlayHost.clearSource(LIGHTNING_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(LIGHTNING_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _cellCount = 0;
    },

    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const out = [];
      let i = 0;
      for (const rec of _active.values()) {
        if (out.length >= maxCount) break;
        out.push(
          mapAnalystRecord(
            {
              id: rec.entity?.id,
              lat: rec.lat,
              lon: rec.lon,
              timeMs: rec.bornAtMs,
              intensity: rec.intensity,
            },
            i,
          ),
        );
        i += 1;
      }
      return out;
    },

    getStats() {
      return {
        count: _active.size,
        cells: _cellCount,
        spawnedTotal: _spawnedTotal,
        lastUpdate: _lastUpdate,
        error: _lastError,
        mode: source?.kind ?? 'unknown',
        modeled: true,
      };
    },
  };
  return layer;
}
