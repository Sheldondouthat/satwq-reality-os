/**
 * Vercel: GET /api/setup/status — read-only key-presence report.
 *
 * This is intentionally NOT the dev server's keySetupEndpoint factory: that
 * factory's admission gate (loopback-only, no proxy headers) would 403 every
 * request on Vercel, where all traffic arrives via the platform's proxy. The
 * gate exists to protect the dev panel's WRITE path (POST /api/setup/keys
 * writes the repo .env and restarts the server). On Vercel there is no write
 * path — POST is a 501 stub (see api/setup/keys.js) — so the read-only
 * presence payload (booleans, never values or suffixes) is safe to serve.
 *
 * The frontend's POWER UP surface renders from this payload; under the
 * VITE_VERCEL build flag the paste/save UI is hidden and a "keys are managed
 * in the Vercel dashboard" note is shown instead (see src/keySetup.js).
 */
import '../_lib/connect.js'; // NOT-CONFIGURED sentinel scrub (keyless parity)
import { keySetupStatus } from '../../src/keySetupCore.mjs';

function respond(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    // A credential-status response must never be cached or framed — same
    // contract as the dev endpoint.
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
  });
  res.end(JSON.stringify(payload));
}

export default async function setupStatusVercel(req, res) {
  if (req.method !== 'GET') {
    return respond(res, 405, { error: 'Method not allowed' });
  }
  const status = keySetupStatus(process.env);
  for (const key of status.keys) {
    // On Vercel every configured key is dashboard-managed: read-only here,
    // changed in the Vercel dashboard. Unset keys stay null (no affordance).
    key.managed = key.set ? 'external' : null;
  }
  respond(res, 200, { ...status, store: 'vercel-dashboard' });
}
