// Vercel: GET /api/nexrad — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { nexradProxy } from '../server/providers/wave9/nexrad.js';

export default mountProvider(() => nexradProxy());
