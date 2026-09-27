/**
 * Vercel: POST /api/setup/keys → 501 stub.
 *
 * The dev server's key-setup endpoint writes the repo-root .env and restarts
 * the server — meaningless on serverless, where keys are managed in the
 * Vercel dashboard (and a function cannot restart its own deployment).
 * The frontend hides the whole save UI under the VITE_VERCEL build flag
 * (see src/keySetup.js); this stub exists so a stray POST fails honestly
 * instead of 404ing.
 */
import '../_lib/connect.js'; // NOT-CONFIGURED sentinel scrub (harmless here)
import { sendJson } from '../_lib/connect.js';

export default async function setupKeysStub(_req, res) {
  sendJson(res, 501, {
    error:
      'Key saving is not available on this deployment: manage provider keys in the Vercel dashboard, then redeploy.',
  });
}
