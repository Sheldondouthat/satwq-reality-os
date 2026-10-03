// Vercel: GET /api/meteor-showers — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { meteorShowersProxy } from '../server/providers/wave6/meteorShowers.js';

export default mountProvider(() => meteorShowersProxy());
