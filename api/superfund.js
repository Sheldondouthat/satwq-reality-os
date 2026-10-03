// Vercel: GET /api/superfund — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { superfundProxy } from '../server/providers/wave9/superfund.js';

export default mountProvider(() => superfundProxy());
