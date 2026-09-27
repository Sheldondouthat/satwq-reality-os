import { createImageryTileLayer } from '../imageryTile/factory.js';
import {
  RAINVIEWER_PRODUCTS,
  RAINVIEWER_CREDIT,
  createRainViewerSource,
} from '../imageryTile/products.js';

const PRODUCT = RAINVIEWER_PRODUCTS.radar;

/** Snapshot source for the layer — exposes getSnapshot for catalog wiring. */
export function createRainviewerRadarSource(options) {
  return createRainViewerSource({ kind: PRODUCT.kind, ...options });
}

export function createRainviewerRadarLayer({ source, ...rest } = {}) {
  return createImageryTileLayer({
    id: PRODUCT.id,
    name: PRODUCT.name,
    icon: PRODUCT.icon,
    sourceLabel: PRODUCT.sourceLabel,
    credit: RAINVIEWER_CREDIT,
    // Template is frame-driven (latest radar frame), so it comes from snapshots.
    urlTemplate: null,
    maximumLevel: PRODUCT.maximumLevel,
    updateInterval: PRODUCT.updateInterval,
    source: source || createRainviewerRadarSource(),
    ...rest,
  });
}
