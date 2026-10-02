// Vercel: GET /api/usgs-quakes-significant-month — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-quakes-significant-month.mjs';

export default mountProvider(() => specProxy('usgs-quakes-significant-month', SPEC));
