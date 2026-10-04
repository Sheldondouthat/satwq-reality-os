// Vercel: GET /api/alert-rules — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { alertRulesProxy } from '../server/providers/wave9/alertRules.js';

export default mountProvider(() => alertRulesProxy());
