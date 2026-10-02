// Vercel: GET /api/mb-release-group-dark-side-of-the-moon — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-release-group-dark-side-of-the-moon.mjs';

export default mountProvider(() => specProxy('mb-release-group-dark-side-of-the-moon', SPEC));
