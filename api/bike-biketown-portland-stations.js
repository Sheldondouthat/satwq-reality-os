// Vercel: GET /api/bike-biketown-portland-stations — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/bike-biketown-portland-stations.mjs';

export default mountProvider(() => specProxy('bike-biketown-portland-stations', SPEC));
