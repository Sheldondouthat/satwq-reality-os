/**
 * Keyless tile-imagery building blocks for the SATWQ Reality OS globe.
 *
 * `factory.js` owns the Cesium UrlTemplateImageryProvider lifecycle;
 * `products.js` owns the product configs and snapshot sources (NASA GIBS,
 * RainViewer). The six concrete layers live in sibling directories and reuse
 * these pieces.
 */
export { createImageryTileLayer } from './factory.js';
export {
  GIBS_WMTS_BASE,
  RAINVIEWER_API_URL,
  GIBS_CREDIT,
  RAINVIEWER_CREDIT,
  GIBS_PRODUCTS,
  RAINVIEWER_PRODUCTS,
  yesterdayDateUTC,
  gibsTileTemplate,
  productUrlTemplate,
  createGibsSource,
  createRainViewerSource,
  normalizeRainViewerSnapshot,
} from './products.js';
