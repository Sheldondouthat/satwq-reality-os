// Vercel: GET /api/apac-jma-tokyo-daily — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-jma-tokyo-daily.mjs';

export default mountProvider(() => specProxy('apac-jma-tokyo-daily', SPEC));
