// Vercel: GET /api/opensky — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { openSkyProxy } from '../server/providers/aircraft/opensky.js';

export default mountProvider(() => openSkyProxy());
