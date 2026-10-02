// Vercel: GET /api/census-tiger-states — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/census-tiger-states.mjs';

export default mountProvider(() => specProxy('census-tiger-states', SPEC));
