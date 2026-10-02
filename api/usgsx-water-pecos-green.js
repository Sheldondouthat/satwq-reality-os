// Vercel: GET /api/usgsx-water-pecos-green — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-water-pecos-green.mjs';

export default mountProvider(() => specProxy('usgsx-water-pecos-green', SPEC));
