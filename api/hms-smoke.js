// Vercel: GET /api/hms-smoke — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { hmsSmokeProxy } from '../server/providers/hmsSmoke.js';

export default mountProvider(() => hmsSmokeProxy());
