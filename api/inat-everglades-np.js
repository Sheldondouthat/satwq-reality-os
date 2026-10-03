// Vercel: GET /api/inat-everglades-np — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/inat-everglades-np.mjs';

export default mountProvider(() => specProxy('inat-everglades-np', SPEC));
