// Vercel: GET /api/geocode — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { geocodeProxy } from '../server/providers/regional/place.js';

export default mountProvider(() => geocodeProxy());
