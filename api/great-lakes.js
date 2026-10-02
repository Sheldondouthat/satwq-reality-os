// Vercel: GET /api/great-lakes — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { greatLakesProxy } from '../server/providers/wave9/greatLakes.js';

export default mountProvider(() => greatLakesProxy());
