// Vercel: GET /api/mb-artist-search-queen — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/mb-artist-search-queen.mjs';

export default mountProvider(() => specProxy('mb-artist-search-queen', SPEC));
