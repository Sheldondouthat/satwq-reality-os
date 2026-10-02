// Vercel: GET /api/coops-watertemp-sandiego — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-watertemp-sandiego.mjs';

export default mountProvider(() => specProxy('coops-watertemp-sandiego', SPEC));
