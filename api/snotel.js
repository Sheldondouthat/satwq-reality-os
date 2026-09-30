// Vercel: GET /api/snotel — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { snotelProxy } from '../server/providers/wave9/snotel.js';

export default mountProvider(() => snotelProxy());
