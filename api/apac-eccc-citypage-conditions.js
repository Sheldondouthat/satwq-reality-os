// Vercel: GET /api/apac-eccc-citypage-conditions — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-eccc-citypage-conditions.mjs';

export default mountProvider(() => specProxy('apac-eccc-citypage-conditions', SPEC));
