// Vercel: GET /api/baltimore-crime-incidents — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/baltimore-crime-incidents.mjs';

export default mountProvider(() => specProxy('baltimore-crime-incidents', SPEC));
