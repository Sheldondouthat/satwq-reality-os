// Vercel: GET /api/coops-airpressure-nome — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/coops-airpressure-nome.mjs';

export default mountProvider(() => specProxy('coops-airpressure-nome', SPEC));
