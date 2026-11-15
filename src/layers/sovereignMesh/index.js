import * as Cesium from 'cesium';
import {
  registerDynamicCredit,
  SOVEREIGN_MESH_COVERAGE_CREDIT,
  SOVEREIGN_MESH_NODES_CREDIT,
} from '../../data/dataCredits.js';
import {
  NODE_COLOR_HEX,
  linkDescription,
  marginStyle,
  nodeDescription,
} from './model.js';
export * from './model.js';
export * from './records.js';
export { createSovereignMeshSource } from './source.js';

/**
 * Own one Sovereign Mesh (nodes) display and its refresh lifecycle.
 * Points from the bridge's nodes[], link lines from links[] colored
 * by margin_class (BM3 §5). PERSONAL class (Amendment A-2): default
 * off, excluded from share links and stored layer state (the catalog
 * carries it as local-only metadata), never on an ambient face.
 *
 * The header label governs the face: the snapshot's `label` and
 * `source` pass through from the bridge untouched, so the replay
 * product on disk renders labeled SYNTHETIC. Node alpha honors the
 * FeedSpec staleness fade (900 s → 0.35 floor) via last_heard_age_s.
 */
export function createSovereignMeshLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Sovereign Mesh requires a snapshot source');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _linkCount = 0;
  let _feedLabel = null;
  let _feedSource = null;
  let _confidence = null;
  let _generatedAt = null;
  let _unavailable = false;
  let _creditsRegistered = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;

  const layer = {
    id: 'sovereign-mesh-nodes',
    name: 'Sovereign Mesh (nodes)',
    icon: '📻',
    source: "Sovereign Mesh — operator's own LoRa mesh · PERSONAL",
    // The FeedSpec's updateIntervalSeconds; the bridge republishes
    // on its own cadence and the provider serves the file verbatim.
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Sovereign Mesh layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('sovereign-mesh-nodes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _linkCount = 0;
      _feedLabel = null;
      _feedSource = null;
      _confidence = null;
      _generatedAt = null;
      _unavailable = false;
      _creditsRegistered = false;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      console.log('[Data:SovereignMesh] Initialized');
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
          // The bridge does not live on this host. Nothing is drawn
          // and nothing is claimed; the stats carry the honest state.
          _count = 0;
          _linkCount = 0;
          _lastUpdate = Date.now();
          _lastError = null;
          console.log(
            '[Data:SovereignMesh] Endpoint reports unavailable (bridge not on this host)',
          );
          return true;
        }

        const header = {
          label: snapshot.label,
          source: snapshot.source,
          confidence: snapshot.confidence,
        };
        const byShortname = new Map(
          snapshot.nodes.map((n) => [n.id, n.shortname]),
        );
        for (const node of snapshot.nodes) {
          const altitudeM =
            node.altitudeM ?? node.groundElevMSrtm ?? 0;
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `sovereign-mesh-node-${node.id}`,
              position: Cesium.Cartesian3.fromDegrees(
                node.lon,
                node.lat,
                altitudeM,
              ),
              point: {
                pixelSize: 11,
                color: Cesium.Color.fromCssColorString(
                  NODE_COLOR_HEX,
                ).withAlpha(node.opacity),
                outlineColor: Cesium.Color.WHITE.withAlpha(node.opacity),
                outlineWidth: 1,
              },
              label: {
                text: node.shortname,
                font: '12px sans-serif',
                fillColor: Cesium.Color.WHITE.withAlpha(node.opacity),
                pixelOffset: new Cesium.Cartesian2(0, -16),
              },
              description: nodeDescription(node, header),
              properties: {
                nodeId: node.id,
                shortname: node.shortname,
                name: node.name,
                feedLabel: snapshot.label,
                feedSource: snapshot.source,
                lastHeardAgeS: node.lastHeardAgeS,
                batteryLevel: node.batteryLevel,
              },
            }),
          );
        }
        for (const link of snapshot.links) {
          const style = marginStyle(link.marginClass);
          _dataSource.entities.add(
            new Cesium.Entity({
              id: `sovereign-mesh-link-${link.fromId}-${link.toId}`,
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights([
                  link.from.lon,
                  link.from.lat,
                  link.from.altitudeM ?? 0,
                  link.to.lon,
                  link.to.lat,
                  link.to.altitudeM ?? 0,
                ]),
                width: style.width,
                material: Cesium.Color.fromCssColorString(style.colorHex),
                arcType: Cesium.ArcType.NONE,
                clampToGround: false,
              },
              description: linkDescription(link, byShortname),
              properties: {
                fromId: link.fromId,
                toId: link.toId,
                marginClass: link.marginClass,
                snrDb: link.snrDb,
                feedLabel: snapshot.label,
              },
            }),
          );
        }

        _count = snapshot.nodes.length;
        _linkCount = snapshot.links.length;
        _lastUpdate = Date.now();
        _lastError = null;
        if (!_creditsRegistered && _viewer) {
          // BM3 §4: both credits land on first render — nodes for the
          // layer itself, coverage for the registered source whose
          // render is computed from this same node set.
          registerDynamicCredit(_viewer, SOVEREIGN_MESH_NODES_CREDIT);
          registerDynamicCredit(_viewer, SOVEREIGN_MESH_COVERAGE_CREDIT);
          _creditsRegistered = true;
        }
        console.log(
          `[Data:SovereignMesh] Updated: ${_count} nodes, ${_linkCount} links (label: ${_feedLabel ?? 'UNLABELED'}, source: ${_feedSource ?? 'unknown'})`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Keep the last good mesh on the globe; the error is reported
        // through getStats, never by silently emptying the layer.
        console.warn('[Data:SovereignMesh] Fetch error:', e);
        _lastError = e?.message || 'Sovereign Mesh source unavailable';
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
      _linkCount = 0;
      _feedLabel = null;
      _feedSource = null;
      _confidence = null;
      _generatedAt = null;
      _unavailable = false;
      _creditsRegistered = false;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        links: _linkCount,
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
