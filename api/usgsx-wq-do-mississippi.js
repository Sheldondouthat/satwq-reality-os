// Vercel: GET /api/usgsx-wq-do-mississippi — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-wq-do-mississippi.mjs';

export default mountProvider(() => specProxy('usgsx-wq-do-mississippi', SPEC));
