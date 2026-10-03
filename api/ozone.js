// Vercel: GET /api/ozone — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { ozoneProxy } from '../server/providers/wave9/earthVitals.js';

export default mountProvider(() => ozoneProxy());
