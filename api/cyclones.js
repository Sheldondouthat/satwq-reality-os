// Vercel: GET /api/cyclones — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { cycloneProxy } from '../server/providers/cyclones.js';

export default mountProvider(() => cycloneProxy());
