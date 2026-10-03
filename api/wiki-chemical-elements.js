// Vercel: GET /api/wiki-chemical-elements — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-chemical-elements.mjs';

export default mountProvider(() => specProxy('wiki-chemical-elements', SPEC));
