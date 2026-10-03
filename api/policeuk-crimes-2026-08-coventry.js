// Vercel: GET /api/policeuk-crimes-2026-08-coventry — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/policeuk-crimes-2026-08-coventry.mjs';

export default mountProvider(() => specProxy('policeuk-crimes-2026-08-coventry', SPEC));
