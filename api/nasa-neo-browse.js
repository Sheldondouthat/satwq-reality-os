// Vercel: GET /api/nasa-neo-browse — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-neo-browse.mjs';

export default mountProvider(() => specProxy('nasa-neo-browse', SPEC));
