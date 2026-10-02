// Vercel: GET /api/nws-alerts-ny — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nws-alerts-ny.mjs';

export default mountProvider(() => specProxy('nws-alerts-ny', SPEC));
