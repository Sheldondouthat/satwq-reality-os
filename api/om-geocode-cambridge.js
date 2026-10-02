// Vercel: GET /api/om-geocode-cambridge — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-geocode-cambridge.mjs';

export default mountProvider(() => specProxy('om-geocode-cambridge', SPEC));
