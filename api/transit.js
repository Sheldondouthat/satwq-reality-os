// Vercel: GET /api/transit — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { transitProxy } from '../server/providers/transit.js';

export default mountProvider(() => transitProxy());
