// Vercel: GET /api/scholar-crossref-longevity — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-crossref-longevity.mjs';

export default mountProvider(() => specProxy('scholar-crossref-longevity', SPEC));
