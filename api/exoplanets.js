// Vercel: GET /api/exoplanets — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { exoplanetsProxy } from '../server/providers/wave9/exoplanets.js';

export default mountProvider(() => exoplanetsProxy());
