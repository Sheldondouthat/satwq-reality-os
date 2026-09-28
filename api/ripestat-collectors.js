// Vercel: GET /api/ripestat-collectors — mounted via the shared connect adapter.
// Collector geometry for the wave3 RIPEstat visualization; the wave6
// country/ASN/prefix query API keeps /api/ripestat.
import { mountProvider } from './_lib/connect.js';
import { ripestatProxy } from '../server/providers/wave3/ripestat.js';

export default mountProvider(() => ripestatProxy({ route: '/api/ripestat-collectors' }));
