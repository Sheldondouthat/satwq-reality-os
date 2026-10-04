/**
 * Build the Pages /api/* middleware stack from the provider registry.
 *
 * Same provider order as server/providers/local.js (dev/prod parity), then
 * the api-not-found plugin last so unmatched /api/* gets a JSON 404 instead
 * of falling through. Each provider is isolated: a load or install failure
 * registers JSON-503 degradation handlers at that provider's routes.
 *
 * Workerd safety: no 'node:' imports here. Provider modules are loaded via
 * dynamic import() so failures are catchable per provider.
 */
import { createMiddlewareStack, useDegraded } from './shim.mjs';
import { REGISTRY } from './registry.mjs';
import { apiNotFoundPlugin } from '../standalone/api-not-found.js';

function summarizeError(err) {
  const msg = err && err.message ? String(err.message) : String(err);
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}

export async function buildPagesStack(log = () => {}) {
  const stack = createMiddlewareStack();
  const status = [];

  for (const entry of REGISTRY) {
    try {
      const plugin = await entry.load();
      if (!plugin || typeof plugin.configureServer !== 'function') {
        throw new Error('provider did not return a Vite plugin');
      }
      plugin.configureServer({ middlewares: stack });
      status.push({
        provider: entry.name,
        state: 'live',
        routes: entry.routes,
      });
    } catch (err) {
      const reason = summarizeError(err);
      log(`[pages-api] provider degraded: ${entry.name}: ${reason}`);
      useDegraded(stack, entry.routes, entry.name, reason);
      status.push({
        provider: entry.name,
        state: 'degraded',
        routes: entry.routes,
        reason,
      });
    }
  }

  // Unmatched /api/* → JSON 404, mirroring prod-server.mjs.
  try {
    const plugin = apiNotFoundPlugin();
    if (typeof plugin.configureServer === 'function') {
      plugin.configureServer({ middlewares: stack });
    }
  } catch (err) {
    log(`[pages-api] api-not-found install failed: ${summarizeError(err)}`);
  }

  return { stack, status };
}
