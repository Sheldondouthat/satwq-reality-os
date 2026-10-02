// Vercel: GET /api/faa-delays — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { faaDelaysProxy } from '../server/providers/wave9/faaDelays.js';

export default mountProvider(() => faaDelaysProxy());
