// Vercel: GET /api/om-aq-current-europe — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-aq-current-europe.mjs';

export default mountProvider(() => specProxy('om-aq-current-europe', SPEC));
