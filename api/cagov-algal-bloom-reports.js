// Vercel: GET /api/cagov-algal-bloom-reports — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/cagov-algal-bloom-reports.mjs';

export default mountProvider(() => specProxy('cagov-algal-bloom-reports', SPEC));
