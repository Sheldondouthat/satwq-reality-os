// Vercel: GET /api/hazards — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { hazardsProxy } from '../server/providers/wave5/hazards.js';

export default mountProvider(() => hazardsProxy());
