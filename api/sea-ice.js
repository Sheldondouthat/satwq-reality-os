// Vercel: GET /api/sea-ice — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { seaIceProxy } from '../server/providers/wave9/earthVitals.js';

export default mountProvider(() => seaIceProxy());
