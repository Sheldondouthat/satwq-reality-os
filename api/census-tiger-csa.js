// Vercel: GET /api/census-tiger-csa — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/census-tiger-csa.mjs';

export default mountProvider(() => specProxy('census-tiger-csa', SPEC));
