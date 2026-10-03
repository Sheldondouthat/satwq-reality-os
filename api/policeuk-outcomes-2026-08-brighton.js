// Vercel: GET /api/policeuk-outcomes-2026-08-brighton — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/policeuk-outcomes-2026-08-brighton.mjs';

export default mountProvider(() => specProxy('policeuk-outcomes-2026-08-brighton', SPEC));
