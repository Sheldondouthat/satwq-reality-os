// Vercel: GET /api/wiki-countries-gdp — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/wiki-countries-gdp.mjs';

export default mountProvider(() => specProxy('wiki-countries-gdp', SPEC));
