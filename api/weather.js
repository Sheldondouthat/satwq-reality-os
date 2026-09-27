// Vercel: GET /api/weather — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { weatherProxy } from '../server/providers/weather.js';

export default mountProvider(() => weatherProxy());
