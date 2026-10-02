// Vercel: GET /api/ocearch — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { ocearchProxy } from '../server/providers/wave9/ocearch.js';

export default mountProvider(() => ocearchProxy());
