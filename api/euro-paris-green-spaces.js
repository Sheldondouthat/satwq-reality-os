// Vercel: GET /api/euro-paris-green-spaces — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/euro-paris-green-spaces.mjs';

export default mountProvider(() => specProxy('euro-paris-green-spaces', SPEC));
