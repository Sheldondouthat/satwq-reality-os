// Vercel: GET /api/radio — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { radioBrowserProxy } from '../server/providers/radio.js';

export default mountProvider(() => radioBrowserProxy());
