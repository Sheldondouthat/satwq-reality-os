// Vercel: GET /api/fda-device-recall-va — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/fda-device-recall-va.mjs';

export default mountProvider(() => specProxy('fda-device-recall-va', SPEC));
