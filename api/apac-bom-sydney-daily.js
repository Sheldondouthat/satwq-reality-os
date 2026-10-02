// Vercel: GET /api/apac-bom-sydney-daily — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-bom-sydney-daily.mjs';

export default mountProvider(() => specProxy('apac-bom-sydney-daily', SPEC));
