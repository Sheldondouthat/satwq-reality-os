// Vercel: GET /api/ol-search-solar — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/ol-search-solar.mjs';

export default mountProvider(() => specProxy('ol-search-solar', SPEC));
