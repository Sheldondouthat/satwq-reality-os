// Vercel: GET /api/overpass — mounted via the shared connect adapter.
// (overpassProxy also installs /api/route; each Vercel function file mounts
// the same factory and the adapter dispatches only the matching route.)
import { mountProvider } from './_lib/connect.js';
import { overpassProxy } from '../server/providers/overpass.js';

export default mountProvider(() => overpassProxy());
