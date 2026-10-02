// Vercel: GET /api/usgsx-volcano-avo — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-volcano-avo.mjs';

export default mountProvider(() => specProxy('usgsx-volcano-avo', SPEC));
