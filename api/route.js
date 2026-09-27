// Vercel: GET /api/route — mounted via the shared connect adapter.
// (Installed by overpassProxy's installRouteMiddleware; the same factory also
// serves /api/overpass. Each Vercel function file mounts the same factory and
// the adapter dispatches only the matching route.)
import { mountProvider } from './_lib/connect.js';
import { overpassProxy } from '../server/providers/overpass.js';

export default mountProvider(() => overpassProxy());
