// Vercel: GET /api/morning-briefing — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { morningBriefingProxy } from '../server/providers/wave9/morningBriefing.js';

export default mountProvider(() => morningBriefingProxy());
