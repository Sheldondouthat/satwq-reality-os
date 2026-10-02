// Vercel: GET /api/usgsx-quakes-indonesia — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-quakes-indonesia.mjs';

export default mountProvider(() => specProxy('usgsx-quakes-indonesia', SPEC));
