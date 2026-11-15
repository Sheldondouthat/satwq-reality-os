// Vercel: GET /api/fusion-river — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { fusionRiverProxy } from '../server/providers/wave3/fusionRiver.js';

export default mountProvider(() => fusionRiverProxy());
