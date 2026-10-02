// Vercel: GET /api/coops-wind-keywest — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-wind-keywest.mjs';

export default mountProvider(() => specProxy('coops-wind-keywest', SPEC));
