// Vercel: GET /api/usgs-sig-quakes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgs-sig-quakes.mjs';

export default mountProvider(() => specProxy('usgs-sig-quakes', SPEC));
