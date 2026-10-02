// Vercel: GET /api/apac-jma-osaka-daily — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/apac-jma-osaka-daily.mjs';

export default mountProvider(() => specProxy('apac-jma-osaka-daily', SPEC));
