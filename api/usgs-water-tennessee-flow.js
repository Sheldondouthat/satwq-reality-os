// Vercel: GET /api/usgs-water-tennessee-flow — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-water-tennessee-flow.mjs';

export default mountProvider(() => specProxy('usgs-water-tennessee-flow', SPEC));
