// Vercel: GET /api/census-tiger-puma-va — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/census-tiger-puma-va.mjs';

export default mountProvider(() => specProxy('census-tiger-puma-va', SPEC));
