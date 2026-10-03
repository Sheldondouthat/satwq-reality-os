// Vercel: GET /api/tfl-road-corridor-a406 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/tfl-road-corridor-a406.mjs';

export default mountProvider(() => specProxy('tfl-road-corridor-a406', SPEC));
