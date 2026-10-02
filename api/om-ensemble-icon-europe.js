// Vercel: GET /api/om-ensemble-icon-europe — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-ensemble-icon-europe.mjs';

export default mountProvider(() => specProxy('om-ensemble-icon-europe', SPEC));
