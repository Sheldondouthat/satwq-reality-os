// Vercel: GET /api/weather-effects — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { weatherEffectsProxy } from '../server/providers/regional/weather-effects.js';

export default mountProvider(() => weatherEffectsProxy());
