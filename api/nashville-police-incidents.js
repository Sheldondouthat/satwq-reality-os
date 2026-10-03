// Vercel: GET /api/nashville-police-incidents — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nashville-police-incidents.mjs';

export default mountProvider(() => specProxy('nashville-police-incidents', SPEC));
