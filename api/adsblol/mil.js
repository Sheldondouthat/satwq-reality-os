// Vercel: GET /api/adsblol/mil — mounted via the shared connect adapter.
import { mountProvider } from '../_lib/connect.js';
import { adsbLolProxy } from '../../server/providers/aircraft/adsb-lol.js';

export default mountProvider(() => adsbLolProxy());
