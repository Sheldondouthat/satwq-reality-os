// Vercel: GET /api/apac-hko-9day — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-hko-9day.mjs';

export default mountProvider(() => specProxy('apac-hko-9day', SPEC));
