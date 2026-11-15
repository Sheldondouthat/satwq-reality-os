import * as Cesium from 'cesium';
import {
  registerDynamicCredit,
  SOVEREIGN_MESH_COVERAGE_CREDIT,
} from '../../data/dataCredits.js';
import { BUNDLED_TERRAIN_GRID, computeCoverage } from './coverage.js';
import { COVERAGE_FILL_ALPHA, coverageCellDescription, coverageColorHex } from './model.js';
export * from './coverage.js';
export * from './model.js';

/**
 * Own the Sovereign Mesh (coverage) display and its refresh
 * lifecycle (BM3 §5 follow-on — the render the registry move
 * recorded as designed-not-built).
 *
 * Coverage has no endpoint and no payload (spec §5): the render is
 * computed locally, in the browser, from the SRTM terrain grid
 * bundled with this layer and the node set the nodes feed reports —
 * the same snapshot the nodes layer consumes, fetched through the
 * same source contract. Each terrain cell the model predicts a link
 * for is recolored on the ground in the mesh family's margin
 * palette; cells predicted BLOCKED to every node are not drawn.
 *
 * PERSONAL class (Amendment A-2), exactly as the nodes layer:
 * default off, local-only catalog disposition (never in share links
 * or stored layer state), grouped under Personal in the panel.
 * The snapshot header governs the face — the coverage of a
 * SYNTHETIC replay is labeled SYNTHETIC in every cell description,
 * and the FeedSpec confidence (Modeled) is never upgraded. The
 * coverage FeedSpec carries no staleness fade (floor 1.0, 0 s): the
 * prediction is a function of terrain and node positions, so cells
 * render at full strength while the layer is enabled; node
 * *freshness* stays the nodes layer's story.
 */
export function createSovereignMeshCoverageLayer({ source, grid } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Sovereign Mesh coverage requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _byClass = { strong: 0, workable: 0, marginal: 0 };
  let _totalCells = 0;
  let _skippedNodes = 0;
  let _feedLabel = null;
  let _feedSource = null;
  let _confidence = null;
  let _generatedAt = null;
  let _unavailable = false;
  let _creditRegistered = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const resetStats = () => {
    _count = 0;
    _byClass = { strong: 0, workable: 0, marginal: 0 };
    _totalCells = 0;
    _skippedNodes = 0;
  };

  const layer = {
    id: 'sovereign-mesh-coverage',
    name: 'Sovereign Mesh (coverage)',
    icon: '📶',
    source: 'Sovereign Mesh coverage — computed locally · PERSONAL',
    // No cadence of its own (the coverage FeedSpec's interval is 0):
    // it refreshes on the nodes feed's cadence, from the same
    // snapshot, whenever the operator has it enabled.
    updateInterval: 60000,

    init(viewer) {
      if (_viewer)
        throw new Error('Sovereign Mesh coverage layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sovereign-mesh-coverage');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      resetStats();
      _feedLabel = null;
      _feedSource = null;
      _confidence = null;
      _generatedAt = null;
      _unavailable = false;
      _creditRegistered = false;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:SovereignMeshCoverage] Initialized');
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

        _feedLabel = snapshot.label;
        _feedSource = snapshot.source;
        _confidence = snapshot.confidence;
        _generatedAt = snapshot.generatedAt;
        _unavailable = snapshot.unavailable === true;

        _dataSource.entities.removeAll();
        if (_unavailable) {
          // No node set on this host means no coverage to compute:
          // nothing is drawn and nothing is claimed.
          resetStats();
          _lastUpdate = Date.now();
          _lastError = null;
          console.log(
            '[Data:SovereignMeshCoverage] Endpoint reports unavailable (bridge not on this host) — no coverage computed',
          );
          return true;
        }

        const header = {
          label: snapshot.label,
          source: snapshot.source,
          confidence: snapshot.confidence,
        };
        const { cells, skippedNodes } = computeCoverage(
          snapshot.nodes,
          grid,
        );
        for (const cell of cells) {
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `sovereign-mesh-coverage-${cell.row}-${cell.col}`,
              polygon: {
                hierarchy: new Cesium.PolygonHierarchy(
                  cell.corners.map((c) =>
                    Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.elevM),
                  ),
                ),
                perPositionHeight: true,
                material: Cesium.Color.fromCssColorString(
                  coverageColorHex(cell.marginClass),
                ).withAlpha(COVERAGE_FILL_ALPHA),
              },
              description: coverageCellDescription(cell, header),
              properties: {
                bestNodeId: cell.bestNodeId,
                bestShortname: cell.bestShortname,
                marginClass: cell.marginClass,
                verdict: cell.verdict,
                minClearM: cell.minClearM,
                minFresnelMarginM: cell.minFresnelMarginM,
                fsplExcessDb: cell.fsplExcessDb,
                feedLabel: snapshot.label,
                feedSource: snapshot.source,
              },
            }),
          );
        }

        _count = cells.length;
        _byClass = { strong: 0, workable: 0, marginal: 0 };
        for (const cell of cells) _byClass[cell.marginClass] += 1;
        const activeGrid = grid ?? BUNDLED_TERRAIN_GRID;
        _totalCells =
          (activeGrid.lats.length - 1) * (activeGrid.lons.length - 1);
        _skippedNodes = skippedNodes;
        _lastUpdate = Date.now();
        _lastError = null;
        if (!_creditRegistered && _viewer) {
          registerDynamicCredit(_viewer, SOVEREIGN_MESH_COVERAGE_CREDIT);
          _creditRegistered = true;
        }
        console.log(
          `[Data:SovereignMeshCoverage] Updated: ${_count} covered cells of ${_totalCells} (strong ${_byClass.strong}, workable ${_byClass.workable}, marginal ${_byClass.marginal}; label: ${_feedLabel ?? 'UNLABELED'})`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Keep the last good coverage on the globe; the error is
        // reported through getStats, never by silently emptying.
        console.warn('[Data:SovereignMeshCoverage] Compute error:', e);
        _lastError = e?.message || 'Sovereign Mesh coverage source unavailable';
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
      resetStats();
      _feedLabel = null;
      _feedSource = null;
      _confidence = null;
      _generatedAt = null;
      _unavailable = false;
      _creditRegistered = false;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        byClass: { ..._byClass },
        totalCells: _totalCells,
        skippedNodes: _skippedNodes,
        feedLabel: _feedLabel,
        feedSource: _feedSource,
        confidence: _confidence,
        generatedAt: _generatedAt,
        unavailable: _unavailable,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
