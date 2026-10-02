// Vercel: GET /api/socrata-seattle-police911 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-seattle-police911.mjs';

export default mountProvider(() => specProxy('socrata-seattle-police911', SPEC));
