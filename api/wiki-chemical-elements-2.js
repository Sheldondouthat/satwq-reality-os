// Vercel: GET /api/wiki-chemical-elements-2 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-chemical-elements-2.mjs';

export default mountProvider(() => specProxy('wiki-chemical-elements-2', SPEC));
