// Vercel: GET /api/cdec-reservoir-elevation — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/cdec-reservoir-elevation.mjs';

export default mountProvider(() => specProxy('cdec-reservoir-elevation', SPEC));
