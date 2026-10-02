// Vercel: GET /api/usgs-water-sanjoaquin-flow — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-water-sanjoaquin-flow.mjs';

export default mountProvider(() => specProxy('usgs-water-sanjoaquin-flow', SPEC));
