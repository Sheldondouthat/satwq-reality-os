/**
 * Wave 3 Track 2c / 2.17 — AISHub volunteer receiver-station mesh.
 *
 * init({ viewer }) mounts a fail-soft Cesium layer: markers for AISHub's
 * volunteer AIS receiver stations (keyless station export). Color encodes
 * station freshness: green = heard within the hour, gold = today,
 * blue-grey = older. Receiver infrastructure only — no vessel positions.
 */
import { mountPollingLayer, escapeHtml } from '../common/layer.js';
import { freshnessBucket, freshnessColorCss, pickStations } from './model.js';
import { createAishubSource } from './source.js';

export * from './model.js';
export { createAishubSource } from './source.js';

const REFRESH_MS = 30 * 60_000;

function seenLabel(lastSeen) {
  if (!Number.isFinite(lastSeen)) return 'unknown';
  const ageMin = Math.max(0, Math.floor(Date.now() / 1000 - lastSeen) / 60);
  if (ageMin < 60) return `${Math.floor(ageMin)} min ago`;
  if (ageMin < 1440) return `${Math.floor(ageMin / 60)} h ago`;
  return `${Math.floor(ageMin / 1440)} d ago`;
}

export function init({ viewer, apiPath = '/api/aishub' } = {}) {
  try {
    const { init: mount } = mountPollingLayer({
      name: 'wave3-aishub',
      apiPath,
      intervalMs: REFRESH_MS,
      render({ dataSource, data, Cesium }) {
        dataSource.entities.removeAll();
        const nowSec = Math.floor(Date.now() / 1000);
        for (const s of pickStations(data.stations, nowSec)) {
          const bucket = freshnessBucket(s.lastSeen, nowSec);
          const color = Cesium.Color.fromCssColorString(freshnessColorCss(bucket));
          dataSource.entities.add({
            id: `aishub:${s.id}`,
            position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 10000),
            point: {
              pixelSize: 5,
              color: color.withAlpha(0.9),
              outlineColor: Cesium.Color.WHITE.withAlpha(0.5),
              outlineWidth: 1,
            },
            description:
              `<h3>AIS receiver #${escapeHtml(s.id)}</h3>` +
              `<p>${escapeHtml(s.location) || 'Unnamed station'}` +
              `${s.country ? ` (${escapeHtml(s.country.toUpperCase())})` : ''}</p>` +
              `<p>Last report: ${seenLabel(s.lastSeen)}.</p>` +
              `<p style="opacity:.7">Volunteer receiver infrastructure © AISHub (via /api/aishub). ` +
              `No vessel positions.</p>`,
          });
        }
      },
    });
    return mount({ viewer });
  } catch (error) {
    console.warn('[wave3:aishub] init failed:', error?.message || error);
    return null;
  }
}
