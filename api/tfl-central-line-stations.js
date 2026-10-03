// Vercel: GET /api/tfl-central-line-stations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-central-line-stations.mjs';

export default mountProvider(() => specProxy('tfl-central-line-stations', SPEC));
