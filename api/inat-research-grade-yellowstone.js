// Vercel: GET /api/inat-research-grade-yellowstone — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/inat-research-grade-yellowstone.mjs';

export default mountProvider(() => specProxy('inat-research-grade-yellowstone', SPEC));
