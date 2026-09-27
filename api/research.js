// Vercel: GET /api/research — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { researchProxy } from '../server/providers/wave5/research.js';

export default mountProvider(() => researchProxy());
