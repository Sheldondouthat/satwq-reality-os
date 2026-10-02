// Vercel: GET /api/mb-place-royal-albert-hall — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-place-royal-albert-hall.mjs';

export default mountProvider(() => specProxy('mb-place-royal-albert-hall', SPEC));
