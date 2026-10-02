// Vercel: GET /api/coops-airtemp-boston — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-airtemp-boston.mjs';

export default mountProvider(() => specProxy('coops-airtemp-boston', SPEC));
