// Vercel: GET /api/hab — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { habProxy } from '../server/providers/wave9/hab.js';

export default mountProvider(() => habProxy());
