// Vercel: GET /api/terrain/heights — mounted via the shared connect adapter.
import { mountProvider } from '../_lib/connect.js';
import { terrainHeightsProxy } from '../../server/providers/terrain.js';

export default mountProvider(() => terrainHeightsProxy());
