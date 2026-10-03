// Vercel: GET /api/scholar-crossref-ocean-acidification — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-crossref-ocean-acidification.mjs';

export default mountProvider(() => specProxy('scholar-crossref-ocean-acidification', SPEC));
