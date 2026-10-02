// Vercel: GET /api/om-elevation-extremes — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-elevation-extremes.mjs';

export default mountProvider(() => specProxy('om-elevation-extremes', SPEC));
