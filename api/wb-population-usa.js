// Vercel: GET /api/wb-population-usa — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wb-population-usa.mjs';

export default mountProvider(() => specProxy('wb-population-usa', SPEC));
