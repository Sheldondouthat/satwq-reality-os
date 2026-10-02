// Vercel: GET /api/wb-unemployment-usa — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wb-unemployment-usa.mjs';

export default mountProvider(() => specProxy('wb-unemployment-usa', SPEC));
