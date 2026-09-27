// Vercel: GET /api/uv — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { uvProxy } from '../server/providers/wave5/uv.js';

export default mountProvider(() => uvProxy());
