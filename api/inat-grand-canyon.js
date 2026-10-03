// Vercel: GET /api/inat-grand-canyon — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/inat-grand-canyon.mjs';

export default mountProvider(() => specProxy('inat-grand-canyon', SPEC));
