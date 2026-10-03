// Vercel: GET /api/wiki-world-capitals — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-world-capitals.mjs';

export default mountProvider(() => specProxy('wiki-world-capitals', SPEC));
