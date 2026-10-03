// Vercel: GET /api/nasa-epic-natural — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-epic-natural.mjs';

export default mountProvider(() => specProxy('nasa-epic-natural', SPEC));
