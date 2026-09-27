// Vercel: GET /api/fire-perimeters — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { firePerimetersProxy } from '../server/providers/firePerimeters.js';

export default mountProvider(() => firePerimetersProxy());
