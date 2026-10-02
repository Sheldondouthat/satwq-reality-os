// Vercel: GET /api/fda-device-recalls — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/fda-device-recalls.mjs';

export default mountProvider(() => specProxy('fda-device-recalls', SPEC));
