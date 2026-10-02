// Vercel: GET /api/coops-waterlevel-honolulu — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-waterlevel-honolulu.mjs';

export default mountProvider(() => specProxy('coops-waterlevel-honolulu', SPEC));
