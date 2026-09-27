// Vercel: GET /api/co2 — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { co2Proxy } from '../server/providers/wave5/co2.js';

export default mountProvider(() => co2Proxy());
