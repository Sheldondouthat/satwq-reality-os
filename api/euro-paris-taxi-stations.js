// Vercel: GET /api/euro-paris-taxi-stations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/euro-paris-taxi-stations.mjs';

export default mountProvider(() => specProxy('euro-paris-taxi-stations', SPEC));
