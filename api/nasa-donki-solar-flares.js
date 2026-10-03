// Vercel: GET /api/nasa-donki-solar-flares — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-donki-solar-flares.mjs';

export default mountProvider(() => specProxy('nasa-donki-solar-flares', SPEC));
