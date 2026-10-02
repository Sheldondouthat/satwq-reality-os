// Vercel: GET /api/socrata-oakland-crime — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-oakland-crime.mjs';

export default mountProvider(() => specProxy('socrata-oakland-crime', SPEC));
