// Vercel: GET /api/sovereign-mesh-nodes — mounted via the shared connect adapter.
import { mountProvider } from './_lib/connect.js';
import { sovereignMeshProxy } from '../server/providers/local/sovereignMesh.js';

export default mountProvider(() => sovereignMeshProxy());
