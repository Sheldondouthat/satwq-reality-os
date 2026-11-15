// Vercel: GET /api/wspr-live — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { wsprProxy } from '../server/providers/wave6/wspr.js';

export default mountProvider(() => wsprProxy());
