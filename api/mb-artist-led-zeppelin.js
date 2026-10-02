// Vercel: GET /api/mb-artist-led-zeppelin — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-artist-led-zeppelin.mjs';

export default mountProvider(() => specProxy('mb-artist-led-zeppelin', SPEC));
