// Vercel: GET /api/mirova — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { mirovaProxy } from '../server/providers/wave9/mirova.js';

export default mountProvider(() => mirovaProxy());
