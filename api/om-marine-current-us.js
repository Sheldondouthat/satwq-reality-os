// Vercel: GET /api/om-marine-current-us — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-marine-current-us.mjs';

export default mountProvider(() => specProxy('om-marine-current-us', SPEC));
