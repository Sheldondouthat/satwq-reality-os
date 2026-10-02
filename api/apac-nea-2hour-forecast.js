// Vercel: GET /api/apac-nea-2hour-forecast — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-nea-2hour-forecast.mjs';

export default mountProvider(() => specProxy('apac-nea-2hour-forecast', SPEC));
