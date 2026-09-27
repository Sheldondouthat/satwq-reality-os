/**
 * Vercel: POST /api/realtime/debug-log → no-op stub.
 *
 * The dev server's debug-log handler appends voice-diagnostic entries to a
 * `.gev-logs` directory on the operator's machine. A serverless function has
 * no durable local disk worth writing diagnostics to, and the call is
 * fire-and-forget from the frontend (src/voice/realtimeDiagnostics.js) —
 * so on Vercel it is accepted and discarded.
 */
import { sendJson } from '../_lib/connect.js';

export default async function realtimeDebugLogStub(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  // Drain the body so the client never hangs on an unread stream.
  try {
    await new Promise((resolve) => {
      req.on('data', () => {});
      req.on('end', resolve);
      req.on('error', resolve);
    });
  } catch {
    /* ignored */
  }
  sendJson(res, 200, { ok: true, stored: false });
}
