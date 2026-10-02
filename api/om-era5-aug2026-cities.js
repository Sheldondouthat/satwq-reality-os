// Vercel: GET /api/om-era5-aug2026-cities — surge-500 generic spec mount (auto-generated).
import { mountProvider } from './_lib/connect.js';
import { specProxy } from '../server/providers/wave10/generic.js';
import { SPEC } from '../server/providers/wave10/specs/om-era5-aug2026-cities.mjs';

export default mountProvider(() => specProxy('om-era5-aug2026-cities', SPEC));
