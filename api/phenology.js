// Vercel: GET /api/phenology — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { phenoProxy } from '../server/providers/wave9/earthVitals.js';

export default mountProvider(() => phenoProxy());
