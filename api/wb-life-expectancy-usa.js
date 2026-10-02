// Vercel: GET /api/wb-life-expectancy-usa — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wb-life-expectancy-usa.mjs';

export default mountProvider(() => specProxy('wb-life-expectancy-usa', SPEC));
