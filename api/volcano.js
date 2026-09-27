// Vercel: GET /api/volcano — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { volcanoProxy } from '../server/providers/wave5/volcano.js';

export default mountProvider(() => volcanoProxy());
