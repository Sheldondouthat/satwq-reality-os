// Vercel: GET /api/pskreporter — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { pskreporterProxy } from '../server/providers/wave6/pskreporter.js';

export default mountProvider(() => pskreporterProxy());
