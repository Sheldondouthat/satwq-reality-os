// Vercel: GET /api/mb-label-blue-note — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-label-blue-note.mjs';

export default mountProvider(() => specProxy('mb-label-blue-note', SPEC));
