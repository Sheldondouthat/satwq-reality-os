// Vercel: GET /api/wxstations — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { wxstationsProxy } from '../server/providers/wave5/wxstations.js';

export default mountProvider(() => wxstationsProxy());
