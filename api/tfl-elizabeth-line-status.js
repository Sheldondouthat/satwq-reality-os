// Vercel: GET /api/tfl-elizabeth-line-status — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-elizabeth-line-status.mjs';

export default mountProvider(() => specProxy('tfl-elizabeth-line-status', SPEC));
