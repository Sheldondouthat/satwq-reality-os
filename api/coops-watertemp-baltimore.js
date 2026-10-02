// Vercel: GET /api/coops-watertemp-baltimore — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-watertemp-baltimore.mjs';

export default mountProvider(() => specProxy('coops-watertemp-baltimore', SPEC));
