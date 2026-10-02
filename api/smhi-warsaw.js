// Vercel: GET /api/smhi-warsaw — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/smhi-warsaw.mjs';

export default mountProvider(() => specProxy('smhi-warsaw', SPEC));
