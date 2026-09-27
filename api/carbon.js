// Vercel: GET /api/carbon — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { carbonProxy } from '../server/providers/wave5/carbon.js';

export default mountProvider(() => carbonProxy());
