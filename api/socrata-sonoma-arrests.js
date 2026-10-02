// Vercel: GET /api/socrata-sonoma-arrests — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-sonoma-arrests.mjs';

export default mountProvider(() => specProxy('socrata-sonoma-arrests', SPEC));
