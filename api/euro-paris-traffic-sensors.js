// Vercel: GET /api/euro-paris-traffic-sensors — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/euro-paris-traffic-sensors.mjs';

export default mountProvider(() => specProxy('euro-paris-traffic-sensors', SPEC));
