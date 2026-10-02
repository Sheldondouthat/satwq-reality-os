// Vercel: GET /api/coops-currents-capecod — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-currents-capecod.mjs';

export default mountProvider(() => specProxy('coops-currents-capecod', SPEC));
