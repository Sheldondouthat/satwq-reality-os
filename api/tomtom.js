// Vercel: /api/tomtom — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { tomtomProxy } from '../server/providers/traffic.js';

export default mountProvider(() => tomtomProxy());
