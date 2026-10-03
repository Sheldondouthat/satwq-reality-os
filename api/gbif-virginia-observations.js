// Vercel: GET /api/gbif-virginia-observations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/gbif-virginia-observations.mjs';

export default mountProvider(() => specProxy('gbif-virginia-observations', SPEC));
