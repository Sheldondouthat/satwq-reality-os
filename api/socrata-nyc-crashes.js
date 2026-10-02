// Vercel: GET /api/socrata-nyc-crashes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-nyc-crashes.mjs';

export default mountProvider(() => specProxy('socrata-nyc-crashes', SPEC));
