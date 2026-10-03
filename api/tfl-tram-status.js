// Vercel: GET /api/tfl-tram-status — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-tram-status.mjs';

export default mountProvider(() => specProxy('tfl-tram-status', SPEC));
