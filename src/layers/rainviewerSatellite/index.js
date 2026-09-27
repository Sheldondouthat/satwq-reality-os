import { createImageryTileLayer } from '../imageryTile/factory.js';
import {
  RAINVIEWER_PRODUCTS,
  RAINVIEWER_CREDIT,
  createRainViewerSource,
} from '../imageryTile/products.js';

const PRODUCT = RAINVIEWER_PRODUCTS.satellite;

/** Snapshot source for the layer — exposes getSnapshot for catalog wiring. */
export function createRainviewerSatelliteSource(options) {
  return createRainViewerSource({ kind: PRODUCT.kind, ...options });
}

export function createRainviewerSatelliteLayer({ source, ...rest } = {}) {
  return createImageryTileLayer({
    id: PRODUCT.id,
    name: PRODUCT.name,
    icon: PRODUCT.icon,
    sourceLabel: PRODUCT.sourceLabel,
    credit: RAINVIEWER_CREDIT,
    // Template is frame-driven; the infrared array is sometimes empty, in
    // which case the source throws `unavailable` and the layer stays off.
    urlTemplate: null,
    maximumLevel: PRODUCT.maximumLevel,
    updateInterval: PRODUCT.updateInterval,
    source: source || createRainviewerSatelliteSource(),
    ...rest,
  });
}
