// Vercel: GET /api/gbfs — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { gbfsProxy } from '../server/providers/gbfs.js';

export default mountProvider(() => gbfsProxy());
