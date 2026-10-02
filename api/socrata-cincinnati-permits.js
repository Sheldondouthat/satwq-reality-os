// Vercel: GET /api/socrata-cincinnati-permits — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-cincinnati-permits.mjs';

export default mountProvider(() => specProxy('socrata-cincinnati-permits', SPEC));
