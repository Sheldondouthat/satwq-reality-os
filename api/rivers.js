// Vercel: GET /api/rivers — alias of the USGS NWIS gauge sweep
// (catalog #89). The gauge record already carries discharge (00060) +
// gage height (00065), so /api/rivers mounts the same provider rather
// than duplicating the upstream call.
import { mountProvider } from './_lib/connect.js';
import { nwisGaugesProxy } from '../server/providers/wave3/nwisGauges.js';

export default mountProvider(() => nwisGaugesProxy());
