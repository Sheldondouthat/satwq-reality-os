// Vercel: GET /api/scholar-openalex-crispr — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-openalex-crispr.mjs';

export default mountProvider(() => specProxy('scholar-openalex-crispr', SPEC));
