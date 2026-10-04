import * as Cesium from 'cesium';
import { nextTideEvents, tideTrend } from './records.js';
export const TIDE_OVERLAY_SOURCE_ID = 'tides';
export const TIDE_OVERLAY_COHORT_LIMIT = 32;
export const TIDE_OVERLAY_COLLISION_CAPACITY = 16;

export function trendColor(trend) {
  if (trend === 'rising') return Cesium.Color.CYAN;
  if (trend === 'falling') return Cesium.Color.DEEPSKYBLUE;
  return Cesium.Color.GRAY;
}

const fmtTime = (ms) => new Date(ms).toISOString().slice(11, 16) + 'Z';

/**
 * Build the source-owned presentation for one tide station.
 * @param {object} input
 * @param {string} input.id Station id.
 * @param {Cesium.Cartesian3} input.position Ground anchor.
 * @param {string} input.name Station name.
 * @param {Array} input.events High/low events.
 * @param {number} input.nowMs Reference time.
 * @param {string} input.accent Trend color.
 */
export function createTideOverlayEntry({
  id,
  position,
  name,
  events,
  nowMs,
  accent,
}) {
  const { nextHigh, nextLow } = nextTideEvents(events, nowMs);
  const parts = [];
  if (nextHigh)
    parts.push(`High ${nextHigh.v.toFixed(1)} ft ${fmtTime(nextHigh.t)}`);
  if (nextLow)
    parts.push(`Low ${nextLow.v.toFixed(1)} ft ${fmtTime(nextLow.t)}`);
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(name),
    subtitle: parts.join(' · ') || 'No forecast',
    accent,
  };
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `tide-${index}`,
    type: 'tide',
    name: raw.name ?? null,
    trend: raw.trend ?? null,
    nextHigh: raw.nextHigh ?? null,
    nextLow: raw.nextLow ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
  };
}

export { tideTrend };
