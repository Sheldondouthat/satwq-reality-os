// Vercel: GET /api/coops-waterlevel-portlandme — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-waterlevel-portlandme.mjs';

export default mountProvider(() => specProxy('coops-waterlevel-portlandme', SPEC));
