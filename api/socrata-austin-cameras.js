// Vercel: GET /api/socrata-austin-cameras — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-austin-cameras.mjs';

export default mountProvider(() => specProxy('socrata-austin-cameras', SPEC));
