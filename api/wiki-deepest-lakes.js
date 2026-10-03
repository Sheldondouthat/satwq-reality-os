// Vercel: GET /api/wiki-deepest-lakes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-deepest-lakes.mjs';

export default mountProvider(() => specProxy('wiki-deepest-lakes', SPEC));
