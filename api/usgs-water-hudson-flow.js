// Vercel: GET /api/usgs-water-hudson-flow — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-water-hudson-flow.mjs';

export default mountProvider(() => specProxy('usgs-water-hudson-flow', SPEC));
