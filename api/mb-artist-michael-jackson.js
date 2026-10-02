// Vercel: GET /api/mb-artist-michael-jackson — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-artist-michael-jackson.mjs';

export default mountProvider(() => specProxy('mb-artist-michael-jackson', SPEC));
