// Vercel: GET /api/ol-trending-daily — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/ol-trending-daily.mjs';

export default mountProvider(() => specProxy('ol-trending-daily', SPEC));
