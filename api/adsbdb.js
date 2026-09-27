// Vercel: GET /api/adsbdb — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { adsbdbProxy } from '../server/providers/aircraft/enrichment.js';

export default mountProvider(() => adsbdbProxy());
