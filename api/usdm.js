// Vercel: GET /api/usdm — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { usdmProxy } from '../server/providers/wave9/usdm.js';

export default mountProvider(() => usdmProxy());
