// Vercel: GET /api/nasa-donki-cmes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-donki-cmes.mjs';

export default mountProvider(() => specProxy('nasa-donki-cmes', SPEC));
