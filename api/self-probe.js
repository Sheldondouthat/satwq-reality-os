// Vercel: GET /api/self-probe — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { selfProbeProxy } from '../server/providers/wave9/selfProbe.js';

export default mountProvider(() => selfProbeProxy());
