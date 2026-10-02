// Vercel: GET /api/coops-tides-seattle — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-tides-seattle.mjs';

export default mountProvider(() => specProxy('coops-tides-seattle', SPEC));
