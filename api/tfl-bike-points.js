// Vercel: GET /api/tfl-bike-points — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-bike-points.mjs';

export default mountProvider(() => specProxy('tfl-bike-points', SPEC));
