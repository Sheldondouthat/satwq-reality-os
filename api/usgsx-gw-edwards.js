// Vercel: GET /api/usgsx-gw-edwards — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/usgsx-gw-edwards.mjs';

export default mountProvider(() => specProxy('usgsx-gw-edwards', SPEC));
