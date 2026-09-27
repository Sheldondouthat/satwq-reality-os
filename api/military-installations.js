// Vercel: GET /api/military-installations — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { militaryInstallationsProxy } from '../server/providers/military-installations.js';

export default mountProvider(() => militaryInstallationsProxy());
