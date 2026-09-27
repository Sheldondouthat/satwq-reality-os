// Vercel: GET /api/google/text-search — mounted via the shared connect adapter.
import { mountProvider } from '../_lib/connect.js';
import { googlePlacesContextProxy } from '../../server/providers/places.js';

export default mountProvider(() => googlePlacesContextProxy());
