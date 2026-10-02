// Vercel: GET /api/socrata-edmonton-traffic — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-edmonton-traffic.mjs';

export default mountProvider(() => specProxy('socrata-edmonton-traffic', SPEC));
