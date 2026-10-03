// Vercel: GET /api/inat-rocky-mountain-np — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/inat-rocky-mountain-np.mjs';

export default mountProvider(() => specProxy('inat-rocky-mountain-np', SPEC));
