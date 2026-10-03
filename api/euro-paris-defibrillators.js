// Vercel: GET /api/euro-paris-defibrillators — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/euro-paris-defibrillators.mjs';

export default mountProvider(() => specProxy('euro-paris-defibrillators', SPEC));
