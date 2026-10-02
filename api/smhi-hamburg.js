// Vercel: GET /api/smhi-hamburg — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/smhi-hamburg.mjs';

export default mountProvider(() => specProxy('smhi-hamburg', SPEC));
