// Vercel: GET /api/mempool — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { mempoolProxy } from '../server/providers/wave9/mempool.js';

export default mountProvider(() => mempoolProxy());
