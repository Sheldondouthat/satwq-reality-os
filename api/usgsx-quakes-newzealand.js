// Vercel: GET /api/usgsx-quakes-newzealand — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-quakes-newzealand.mjs';

export default mountProvider(() => specProxy('usgsx-quakes-newzealand', SPEC));
