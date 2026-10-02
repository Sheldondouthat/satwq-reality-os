// Vercel: GET /api/socrata-cincinnati-crashes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-cincinnati-crashes.mjs';

export default mountProvider(() => specProxy('socrata-cincinnati-crashes', SPEC));
