// Vercel: /api/cctv — mounted via the shared connect adapter.
// sourceRoot is passed explicitly (absolute) exactly as
// server/providers/local.js does, so the CCTV catalog reads resolve against
// the bundled checkout and never against the adapter's tmpdir cwd.
import { mountProvider } from './_lib/connect.js';
import { cctvProxy } from '../server/providers/cctv.js';
import { defaultSourceRoot } from '../server/providers/common/source-root.js';

export default mountProvider(() => cctvProxy({ sourceRoot: defaultSourceRoot }));
