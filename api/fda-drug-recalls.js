// Vercel: GET /api/fda-drug-recalls — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/fda-drug-recalls.mjs';

export default mountProvider(() => specProxy('fda-drug-recalls', SPEC));
