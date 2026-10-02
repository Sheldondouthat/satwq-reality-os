// Vercel: GET /api/mb-artist-the-beatles — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-artist-the-beatles.mjs';

export default mountProvider(() => specProxy('mb-artist-the-beatles', SPEC));
