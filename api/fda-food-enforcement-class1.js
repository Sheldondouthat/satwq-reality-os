// Vercel: GET /api/fda-food-enforcement-class1 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/fda-food-enforcement-class1.mjs';

export default mountProvider(() => specProxy('fda-food-enforcement-class1', SPEC));
