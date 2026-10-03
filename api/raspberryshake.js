// Vercel: GET /api/raspberryshake — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { raspberryShakeProxy } from '../server/providers/wave9/raspberryshake.js';

export default mountProvider(() => raspberryShakeProxy());
