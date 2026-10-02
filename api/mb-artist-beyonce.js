// Vercel: GET /api/mb-artist-beyonce — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-artist-beyonce.mjs';

export default mountProvider(() => specProxy('mb-artist-beyonce', SPEC));
