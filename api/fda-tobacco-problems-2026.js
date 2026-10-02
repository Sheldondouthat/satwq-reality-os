// Vercel: GET /api/fda-tobacco-problems-2026 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/fda-tobacco-problems-2026.mjs';

export default mountProvider(() => specProxy('fda-tobacco-problems-2026', SPEC));
