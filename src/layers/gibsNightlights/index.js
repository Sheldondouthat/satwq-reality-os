import { createImageryTileLayer } from '../imageryTile/factory.js';
import {
  GIBS_PRODUCTS,
  GIBS_CREDIT,
  createGibsSource,
  productUrlTemplate,
} from '../imageryTile/products.js';

const PRODUCT = GIBS_PRODUCTS.nightlights;

/** Snapshot source for the layer — exposes getSnapshot for catalog wiring. */
export function createGibsNightlightsSource(options) {
  return createGibsSource(PRODUCT, options);
}

export function createGibsNightlightsLayer({ source, ...rest } = {}) {
  return createImageryTileLayer({
    id: PRODUCT.id,
    name: PRODUCT.name,
    icon: PRODUCT.icon,
    sourceLabel: PRODUCT.sourceLabel,
    credit: GIBS_CREDIT,
    urlTemplate: productUrlTemplate(PRODUCT),
    maximumLevel: PRODUCT.maximumLevel,
    updateInterval: PRODUCT.updateInterval,
    source: source || createGibsNightlightsSource(),
    ...rest,
  });
}
