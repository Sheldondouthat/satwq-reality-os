// Vercel: GET /api/launches — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { rocketLaunchesProxy } from '../server/providers/space.js';

export default mountProvider(() => rocketLaunchesProxy());
