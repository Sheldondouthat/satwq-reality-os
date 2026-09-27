/**
 * Akashic Records — globe marker layer.
 *
 * Owns one Cesium CustomDataSource ("akashic-records") and paints the recorded
 * events as point markers. The replay controller decides WHICH events are
 * visible (via cutoff); this module only decides HOW they look.
 *
 * In live mode the markers show the recent log; in replay mode they show the
 * log up to the playhead. Live data layers are untouched — replay is additive,
 * and the timeline UI badges the mode so there is no confusion.
 */
import * as Cesium from 'cesium';
import { filterEventsUpTo } from './timeline.js';

export const AKASHIC_SOURCE_NAME = 'akashic-records';
export const AKASHIC_RENDER_CAP = 1500;

const TYPE_COLORS = {
  earthquake: Cesium.Color.ORANGERED,
  volcano: Cesium.Color.RED,
  meteor: Cesium.Color.CYAN,
  launch: Cesium.Color.LIME,
  fire: Cesium.Color.DARKORANGE,
  custom: Cesium.Color.MEDIUMSLATEBLUE,
};

function colorFor(event) {
  const base = TYPE_COLORS[event.type] ?? TYPE_COLORS.custom;
  // Brighter for severe events.
  const s = typeof event.severity === 'number' ? event.severity : 0.4;
  return base.withAlpha(0.55 + 0.45 * s);
}

function sizeFor(event) {
  const s = typeof event.severity === 'number' ? event.severity : 0.4;
  return 5 + Math.round(9 * s);
}

function descriptionFor(event) {
  const when = new Date(event.time).toLocaleString();
  const lines = [
    `<b>${escapeHtml(event.title)}</b>`,
    `${escapeHtml(event.type)} · ${when}`,
  ];
  if (event.detail) lines.push(escapeHtml(event.detail));
  if (event.source) lines.push(`Source: ${escapeHtml(event.source)}`);
  if (event.url)
    lines.push(
      `<a href="${escapeHtml(event.url)}" target="_blank" rel="noopener">source record</a>`,
    );
  return lines.join('<br>');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} options
 * @param {object} options.viewer Cesium viewer (required).
 */
export function createAkashicGlobeLayer({ viewer } = {}) {
  if (!viewer?.dataSources) throw new TypeError('Akashic globe layer requires a viewer');
  const dataSource = new Cesium.CustomDataSource(AKASHIC_SOURCE_NAME);
  viewer.dataSources.add(dataSource);
  let visible = true;
  let lastRendered = 0;

  function render(events, { cutoff = Infinity } = {}) {
    const inScope = filterEventsUpTo(events, cutoff);
    // Most severe first so the cap keeps the events that matter.
    const ranked = inScope
      .slice()
      .sort(
        (a, b) =>
          (b.severity ?? 0) - (a.severity ?? 0) || b.time - a.time,
      )
      .slice(0, AKASHIC_RENDER_CAP);
    dataSource.entities.removeAll();
    for (const event of ranked) {
      dataSource.entities.add({
        id: event.id,
        position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat),
        point: {
          pixelSize: sizeFor(event),
          color: colorFor(event),
          outlineColor: Cesium.Color.WHITE.withAlpha(0.7),
          outlineWidth: 1,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        description: descriptionFor(event),
      });
    }
    dataSource.show = visible;
    lastRendered = ranked.length;
    return lastRendered;
  }

  return {
    render,
    clear() {
      dataSource.entities.removeAll();
      lastRendered = 0;
    },
    setVisible(next) {
      visible = Boolean(next);
      dataSource.show = visible;
    },
    get renderedCount() {
      return lastRendered;
    },
    dispose() {
      viewer.dataSources.remove(dataSource, true);
    },
  };
}
