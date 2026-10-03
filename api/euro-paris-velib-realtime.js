// Vercel: GET /api/euro-paris-velib-realtime — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/euro-paris-velib-realtime.mjs';

export default mountProvider(() => specProxy('euro-paris-velib-realtime', SPEC));
