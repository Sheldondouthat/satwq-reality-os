// Vercel: GET /api/google/nearby-places — mounted via the shared connect adapter.
// (googlePlacesContextProxy also serves /api/google/text-search; each Vercel
// function file mounts the same factory and the adapter dispatches only the
// matching route.)
import { mountProvider } from '../_lib/connect.js';
import { googlePlacesContextProxy } from '../../server/providers/places.js';

export default mountProvider(() => googlePlacesContextProxy());
