// Vercel: GET /api/felt — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { feltProxy } from '../server/providers/wave5/felt.js';

export default mountProvider(() => feltProxy());
