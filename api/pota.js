// Vercel: GET /api/pota — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { potaProxy } from '../server/providers/wave5/pota.js';

export default mountProvider(() => potaProxy());
