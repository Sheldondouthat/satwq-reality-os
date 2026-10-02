// Vercel: GET /api/socrata-oakland-311 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-oakland-311.mjs';

export default mountProvider(() => specProxy('socrata-oakland-311', SPEC));
