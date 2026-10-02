// Vercel: GET /api/wb-indicator-catalog — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wb-indicator-catalog.mjs';

export default mountProvider(() => specProxy('wb-indicator-catalog', SPEC));
