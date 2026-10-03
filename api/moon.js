// Vercel: GET /api/moon — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { lunarProxy } from '../server/providers/wave9/lunar.js';

export default mountProvider(() => lunarProxy());
