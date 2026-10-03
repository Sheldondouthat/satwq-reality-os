// Vercel: GET /api/chicago-food-inspections — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/chicago-food-inspections.mjs';

export default mountProvider(() => specProxy('chicago-food-inspections', SPEC));
