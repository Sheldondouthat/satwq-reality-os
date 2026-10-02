// Vercel: GET /api/usace — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { usaceProxy } from '../server/providers/wave9/usace.js';

export default mountProvider(() => usaceProxy());
