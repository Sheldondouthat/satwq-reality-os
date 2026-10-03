// Vercel: GET /api/minneapolis-311-requests — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/minneapolis-311-requests.mjs';

export default mountProvider(() => specProxy('minneapolis-311-requests', SPEC));
