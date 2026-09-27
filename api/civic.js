// Vercel: GET /api/civic — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { civicProxy } from '../server/providers/wave5/civic.js';

export default mountProvider(() => civicProxy());
