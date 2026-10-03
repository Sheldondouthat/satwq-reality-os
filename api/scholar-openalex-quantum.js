// Vercel: GET /api/scholar-openalex-quantum — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-openalex-quantum.mjs';

export default mountProvider(() => specProxy('scholar-openalex-quantum', SPEC));
