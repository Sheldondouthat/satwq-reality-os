// Vercel: GET /api/goes — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { goesProxy } from '../server/providers/wave9/goes.js';

export default mountProvider(() => goesProxy());
