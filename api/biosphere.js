// Vercel: GET /api/biosphere — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { biosphereProxy } from '../server/providers/wave5/biosphere.js';

export default mountProvider(() => biosphereProxy());
