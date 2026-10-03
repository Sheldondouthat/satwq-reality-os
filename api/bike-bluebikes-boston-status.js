// Vercel: GET /api/bike-bluebikes-boston-status — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/bike-bluebikes-boston-status.mjs';

export default mountProvider(() => specProxy('bike-bluebikes-boston-status', SPEC));
