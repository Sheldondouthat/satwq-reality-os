// Vercel: GET /api/certs — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { certsProxy } from '../server/providers/wave5/certs.js';

export default mountProvider(() => certsProxy());
