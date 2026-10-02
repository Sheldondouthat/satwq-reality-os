// Vercel: GET /api/apac-ipma-porto-daily — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-ipma-porto-daily.mjs';

export default mountProvider(() => specProxy('apac-ipma-porto-daily', SPEC));
