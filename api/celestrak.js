// Vercel: GET /api/celestrak — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { celestrakProxy } from '../server/providers/space.js';

export default mountProvider(() => celestrakProxy());
