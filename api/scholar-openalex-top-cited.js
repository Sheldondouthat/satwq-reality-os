// Vercel: GET /api/scholar-openalex-top-cited — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-openalex-top-cited.mjs';

export default mountProvider(() => specProxy('scholar-openalex-top-cited', SPEC));
