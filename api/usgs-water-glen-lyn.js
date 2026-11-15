// Vercel: GET /api/usgs-water-glen-lyn — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { glenLynProxy } from '../server/providers/wave3/glenLyn.js';

export default mountProvider(() => glenLynProxy());
