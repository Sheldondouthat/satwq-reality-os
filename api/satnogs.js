// Vercel: GET /api/satnogs — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { satnogsProxy } from '../server/providers/wave5/satnogs.js';

export default mountProvider(() => satnogsProxy());
