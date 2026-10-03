// Vercel: GET /api/nasa-apod-week-20260925 — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/nasa-apod-week-20260925.mjs';

export default mountProvider(() => specProxy('nasa-apod-week-20260925', SPEC));
