// Vercel: GET /api/nws-hourly-dallas — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nws-hourly-dallas.mjs';

export default mountProvider(() => specProxy('nws-hourly-dallas', SPEC));
