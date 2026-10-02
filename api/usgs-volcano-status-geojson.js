// Vercel: GET /api/usgs-volcano-status-geojson — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-volcano-status-geojson.mjs';

export default mountProvider(() => specProxy('usgs-volcano-status-geojson', SPEC));
