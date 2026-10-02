// Vercel: GET /api/usgsx-quakes-turkey — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-quakes-turkey.mjs';

export default mountProvider(() => specProxy('usgsx-quakes-turkey', SPEC));
