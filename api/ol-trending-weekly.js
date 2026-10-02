// Vercel: GET /api/ol-trending-weekly — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/ol-trending-weekly.mjs';

export default mountProvider(() => specProxy('ol-trending-weekly', SPEC));
