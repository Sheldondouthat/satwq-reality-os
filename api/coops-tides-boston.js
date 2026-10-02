// Vercel: GET /api/coops-tides-boston — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-tides-boston.mjs';

export default mountProvider(() => specProxy('coops-tides-boston', SPEC));
