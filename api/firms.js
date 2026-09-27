// Vercel: GET /api/firms — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { firmsProxy } from '../server/providers/firms.js';

export default mountProvider(() => firmsProxy());
