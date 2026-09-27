// Vercel: GET /api/opensky-track — mounted via the shared connect adapter.
// (trackBackfillProxies also serves /api/adsblol/trace; each Vercel function
// file mounts the same factory and the adapter dispatches only the matching
// route.)
import { mountProvider } from './_lib/connect.js';
import { trackBackfillProxies } from '../server/providers/aircraft/tracks.js';

export default mountProvider(() => trackBackfillProxies());
