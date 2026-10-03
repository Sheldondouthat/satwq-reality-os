// Vercel: GET /api/phoenix-calls-for-service — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/phoenix-calls-for-service.mjs';

export default mountProvider(() => specProxy('phoenix-calls-for-service', SPEC));
