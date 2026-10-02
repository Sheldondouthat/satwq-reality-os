// Vercel: GET /api/coops-salinity-baltimore — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-salinity-baltimore.mjs';

export default mountProvider(() => specProxy('coops-salinity-baltimore', SPEC));
