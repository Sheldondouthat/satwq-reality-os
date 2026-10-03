// Vercel: GET /api/denver-crime-offenses — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/denver-crime-offenses.mjs';

export default mountProvider(() => specProxy('denver-crime-offenses', SPEC));
