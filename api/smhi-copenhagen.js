// Vercel: GET /api/smhi-copenhagen — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/smhi-copenhagen.mjs';

export default mountProvider(() => specProxy('smhi-copenhagen', SPEC));
