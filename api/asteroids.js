// Vercel: GET /api/asteroids — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { asteroidsProxy } from '../server/providers/wave5/asteroids.js';

export default mountProvider(() => asteroidsProxy());
