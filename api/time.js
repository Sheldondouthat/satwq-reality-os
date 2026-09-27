// Vercel: GET /api/time — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { timeProxy } from '../server/providers/wave5/time.js';

export default mountProvider(() => timeProxy());
