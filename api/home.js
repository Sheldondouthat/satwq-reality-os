// Vercel: GET /api/home — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { homeProxy } from '../server/providers/wave9/home.js';

export default mountProvider(() => homeProxy());
