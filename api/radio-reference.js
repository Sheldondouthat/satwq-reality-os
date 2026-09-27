// Vercel: GET /api/radio-reference — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { radioReferenceProxy } from '../server/providers/wave5/radioReference.js';

export default mountProvider(() => radioReferenceProxy());
