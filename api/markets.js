// Vercel: GET /api/markets — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { marketsProxy } from '../server/providers/wave5/markets.js';

export default mountProvider(() => marketsProxy());
