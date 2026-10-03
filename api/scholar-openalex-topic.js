// Vercel: GET /api/scholar-openalex-topic — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/scholar-openalex-topic.mjs';

export default mountProvider(() => specProxy('scholar-openalex-topic', SPEC));
