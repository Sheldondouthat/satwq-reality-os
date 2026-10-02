// Vercel: GET /api/usgsx-water-allegheny-fox — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-water-allegheny-fox.mjs';

export default mountProvider(() => specProxy('usgsx-water-allegheny-fox', SPEC));
