// Vercel: GET /api/pollen — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { pollenProxy } from '../server/providers/wave9/pollen.js';

export default mountProvider(() => pollenProxy());
