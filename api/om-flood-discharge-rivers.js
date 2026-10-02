// Vercel: GET /api/om-flood-discharge-rivers — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-flood-discharge-rivers.mjs';

export default mountProvider(() => specProxy('om-flood-discharge-rivers', SPEC));
