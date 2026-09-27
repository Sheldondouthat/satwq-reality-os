// Vercel: GET /api/wind — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { windProxy } from '../server/providers/wind.js';

export default mountProvider(() => windProxy());
