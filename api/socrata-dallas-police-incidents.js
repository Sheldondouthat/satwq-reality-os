// Vercel: GET /api/socrata-dallas-police-incidents — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/socrata-dallas-police-incidents.mjs';

export default mountProvider(() => specProxy('socrata-dallas-police-incidents', SPEC));
