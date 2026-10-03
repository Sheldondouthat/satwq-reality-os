// Vercel: GET /api/scholar-crossref-quantum-error-correction — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-crossref-quantum-error-correction.mjs';

export default mountProvider(() => specProxy('scholar-crossref-quantum-error-correction', SPEC));
