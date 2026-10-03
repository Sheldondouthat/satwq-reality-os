// Vercel: GET /api/policeuk-stops-2026-07-merseyside — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/policeuk-stops-2026-07-merseyside.mjs';

export default mountProvider(() => specProxy('policeuk-stops-2026-07-merseyside', SPEC));
