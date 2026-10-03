// Vercel: GET /api/bike-niceride-msp-stations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/bike-niceride-msp-stations.mjs';

export default mountProvider(() => specProxy('bike-niceride-msp-stations', SPEC));
