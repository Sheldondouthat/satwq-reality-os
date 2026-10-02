// Vercel: GET /api/metno-madrid — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/metno-madrid.mjs';

export default mountProvider(() => specProxy('metno-madrid', SPEC));
