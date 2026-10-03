// Vercel: GET /api/gbif-south-africa-observations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/gbif-south-africa-observations.mjs';

export default mountProvider(() => specProxy('gbif-south-africa-observations', SPEC));
