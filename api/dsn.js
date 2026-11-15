// Vercel: GET /api/dsn — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { dsnProxy } from '../server/providers/wave6/dsn.js';

export default mountProvider(() => dsnProxy());
