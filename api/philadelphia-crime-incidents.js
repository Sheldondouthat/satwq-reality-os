// Vercel: GET /api/philadelphia-crime-incidents — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/philadelphia-crime-incidents.mjs';

export default mountProvider(() => specProxy('philadelphia-crime-incidents', SPEC));
