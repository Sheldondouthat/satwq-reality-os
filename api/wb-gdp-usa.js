// Vercel: GET /api/wb-gdp-usa — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wb-gdp-usa.mjs';

export default mountProvider(() => specProxy('wb-gdp-usa', SPEC));
