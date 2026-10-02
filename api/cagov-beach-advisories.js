// Vercel: GET /api/cagov-beach-advisories — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/cagov-beach-advisories.mjs';

export default mountProvider(() => specProxy('cagov-beach-advisories', SPEC));
