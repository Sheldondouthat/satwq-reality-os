/**
 * Wave 3 Track 2c / 2.14 — Global Meteor Network nightly streak arcs.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: meteor streak arcs
 * (begin -> end trajectory) for events whose midpoint was on the dark
 * hemisphere at event time. Refreshes every 6 hours (the GMN file is daily).
 */
import { mountPollingLayer, arcPositions } from '../common/layer.js';
import { filterNightSide, streakDeg } from './model.js';
import { createMeteorsSource } from './source.js';

export * from './model.js';
export { createMeteorsSource } from './source.js';

const REFRESH_MS = 6 * 60 * 60_000;

export function init({ viewer, apiPath = '/api/meteors' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-meteors',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        const night = filterNightSide(data.meteors);
        for (const m of night) {
          const len = streakDeg(m);
          const height = Math.max(60000, Math.min(400000, len * 90000));
          dataSource.entities.add({
            id: `meteor:${m.id ?? `${m.timeMs}`}`,
            polyline: {
              positions: arcPositions(m.lonBeg, m.latBeg, m.lonEnd, m.latEnd, height, 16),
              width: Math.max(1, Math.min(3, 1 + len * 2)),
              material: Cesium.Color.CYAN.withAlpha(0.75),
              arcType: Cesium.ArcType.NONE,
            },
            description:
              `<h3>Meteor — ${new Date(m.timeMs).toISOString()}</h3>` +
              `<p>Begin ${m.latBeg.toFixed(2)}°, ${m.lonBeg.toFixed(2)}° → ` +
              `end ${m.latEnd.toFixed(2)}°, ${m.lonEnd.toFixed(2)}°.</p>` +
              (m.vInitKmS != null ? `<p>Entry velocity ≈ ${m.vInitKmS.toFixed(1)} km/s.</p>` : '') +
              (m.massKg != null ? `<p>Estimated mass ≈ ${m.massKg} kg.</p>` : '') +
              `<p style="opacity:.7">Triangulated trajectory © Global Meteor Network (via /api/meteors).</p>`,
          });
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:meteors] init failed:', error?.message || error);
    return null;
  }
}
