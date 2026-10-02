// Vercel: GET /api/coops-currents-chesapeakebridge — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-currents-chesapeakebridge.mjs';

export default mountProvider(() => specProxy('coops-currents-chesapeakebridge', SPEC));
