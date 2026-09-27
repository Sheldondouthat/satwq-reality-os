// Vercel: GET /api/regional-brief — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { regionalBriefProxy } from '../server/providers/regional/briefing.js';

export default mountProvider(() => regionalBriefProxy());
