// Vercel: GET /api/socrata-la-inspections — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-la-inspections.mjs';

export default mountProvider(() => specProxy('socrata-la-inspections', SPEC));
