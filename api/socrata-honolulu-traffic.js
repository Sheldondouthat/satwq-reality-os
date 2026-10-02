// Vercel: GET /api/socrata-honolulu-traffic — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-honolulu-traffic.mjs';

export default mountProvider(() => specProxy('socrata-honolulu-traffic', SPEC));
