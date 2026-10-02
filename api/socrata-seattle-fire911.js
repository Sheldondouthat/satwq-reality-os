// Vercel: GET /api/socrata-seattle-fire911 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-seattle-fire911.mjs';

export default mountProvider(() => specProxy('socrata-seattle-fire911', SPEC));
