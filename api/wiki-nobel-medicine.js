// Vercel: GET /api/wiki-nobel-medicine — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-nobel-medicine.mjs';

export default mountProvider(() => specProxy('wiki-nobel-medicine', SPEC));
