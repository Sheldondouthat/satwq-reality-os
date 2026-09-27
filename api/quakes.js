// Vercel: GET /api/quakes — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { quakesProxy } from '../server/providers/wave5/quakes.js';

export default mountProvider(() => quakesProxy());
