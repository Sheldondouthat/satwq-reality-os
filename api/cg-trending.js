// Vercel: GET /api/cg-trending — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/cg-trending.mjs';

export default mountProvider(() => specProxy('cg-trending', SPEC));
