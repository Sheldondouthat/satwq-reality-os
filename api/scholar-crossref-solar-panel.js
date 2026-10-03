// Vercel: GET /api/scholar-crossref-solar-panel — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-crossref-solar-panel.mjs';

export default mountProvider(() => specProxy('scholar-crossref-solar-panel', SPEC));
