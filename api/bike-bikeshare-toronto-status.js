// Vercel: GET /api/bike-bikeshare-toronto-status — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/bike-bikeshare-toronto-status.mjs';

export default mountProvider(() => specProxy('bike-bikeshare-toronto-status', SPEC));
