// Vercel: GET /api/smhi-amsterdam — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/smhi-amsterdam.mjs';

export default mountProvider(() => specProxy('smhi-amsterdam', SPEC));
