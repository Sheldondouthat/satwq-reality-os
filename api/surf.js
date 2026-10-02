// Vercel: GET /api/surf — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { surfProxy } from '../server/providers/wave9/surf.js';

export default mountProvider(() => surfProxy());
