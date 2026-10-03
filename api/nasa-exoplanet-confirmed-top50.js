// Vercel: GET /api/nasa-exoplanet-confirmed-top50 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-exoplanet-confirmed-top50.mjs';

export default mountProvider(() => specProxy('nasa-exoplanet-confirmed-top50', SPEC));
