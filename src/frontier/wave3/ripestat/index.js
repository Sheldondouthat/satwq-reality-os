/**
 * Wave 3 Track 2c / 2.11 — RIPEstat routing-pulse globe layer.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: pulsing points at each
 * RIS route collector (IXP city) that observes a watched anycast prefix,
 * plus star-topology "pulse" arcs from the best-observed collector to the
 * rest, one color per prefix. Refreshes every 10 minutes.
 *
 * Exported surface: init (fail-soft mount), plus model/source re-exports.
 */
import { mountPollingLayer, arcPositions } from '../common/layer.js';
import {
  locateCollectors,
  starArcs,
  pulseSize,
  PREFIX_COLORS,
} from './model.js';
import { createRipestatSource } from './source.js';

export * from './model.js';
export { createRipestatSource } from './source.js';

const REFRESH_MS = 10 * 60_000;
const MAX_COLLECTORS_PER_PREFIX = 12;

function collectorDescription(prefixDoc, c) {
  const rows = prefixDoc.collectors
    .slice(0, 12)
    .map(
      (x) =>
        `<tr><td>${x.rrc}</td><td>${x.peers}</td><td>${x.avgPathLen ?? '–'}</td></tr>`,
    )
    .join('');
  return (
    `<h3>${c.rrc.toUpperCase()} — ${c.city} (${c.ixp})</h3>` +
    `<p>Prefix <b>${prefixDoc.prefix}</b> · origin AS${prefixDoc.originAsn ?? '?'} · ` +
    `${prefixDoc.totalPeers} peers across ${prefixDoc.collectors.length} collectors.</p>` +
    `<table><tr><th>RRC</th><th>peers</th><th>avg path</th></tr>${rows}</table>` +
    `<p style="opacity:.7">BGP observations © RIPE NCC RIS (via /api/ripestat-collectors).</p>`
  );
}

export function init({ viewer, apiPath = '/api/ripestat-collectors' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-ripestat',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        for (const prefixDoc of data.prefixes ?? []) {
          const located = locateCollectors(prefixDoc.collectors).slice(
            0,
            MAX_COLLECTORS_PER_PREFIX,
          );
          if (!located.length) continue;
          const color = Cesium.Color.fromCssColorString(
            PREFIX_COLORS[prefixDoc.prefix] ?? '#9fc2ff',
          );
          // Pulse points at each collector.
          for (const c of located) {
            const base = pulseSize(c.peers);
            dataSource.entities.add({
              id: `ripestat:${prefixDoc.prefix}:${c.rrc}`,
              position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 20000),
              point: {
                pixelSize: new Cesium.CallbackProperty(
                  () => base + 3 * Math.sin(Date.now() / 900 + c.peers),
                  false,
                ),
                color: color.withAlpha(0.95),
                outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
                outlineWidth: 1,
              },
              label: {
                text: `${c.rrc.toUpperCase()} · ${c.peers}p`,
                font: '10px system-ui, sans-serif',
                fillColor: Cesium.Color.WHITE.withAlpha(0.85),
                pixelOffset: new Cesium.Cartesian2(10, -8),
                scaleByDistance: new Cesium.NearFarScalar(2e6, 1, 3e7, 0),
              },
              description: collectorDescription(prefixDoc, c),
            });
          }
          // Star arcs from the best-observed collector.
          for (const { hub, spoke } of starArcs(located)) {
            dataSource.entities.add({
              id: `ripestat:arc:${prefixDoc.prefix}:${hub.rrc}-${spoke.rrc}`,
              polyline: {
                positions: arcPositions(
                  hub.lon,
                  hub.lat,
                  spoke.lon,
                  spoke.lat,
                  900000,
                ),
                width: 1.5,
                material: color.withAlpha(0.45),
                arcType: Cesium.ArcType.NONE,
              },
            });
          }
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:ripestat] init failed:', error?.message || error);
    return null;
  }
}
