// Vercel: GET /api/tfl-road-disruptions — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-road-disruptions.mjs';

export default mountProvider(() => specProxy('tfl-road-disruptions', SPEC));
