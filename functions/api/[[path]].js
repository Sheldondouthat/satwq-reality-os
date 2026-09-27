/**
 * Cloudflare Pages Function: /api/* for SATWQ // God's Eye.
 *
 * File-based route: functions/api/[[path]].js  →  /api/* (any depth).
 *
 * Runs the REAL provider middleware stack (server/providers/*) through the
 * connect-style shim in server/pages/shim.mjs — the same stack
 * prod-server.mjs mounts in Node, minus the three deliberate exclusions
 * (ais-live WebSocket, LAN receivers, key-setup; see server/pages/registry.mjs).
 *
 * Keyless deploy: Pages env vars flow in via context.env. The literal
 * NOT-CONFIGURED sentinel (or blanks) is scrubbed exactly like
 * prod-server.mjs does, so every provider degrades keyless as designed.
 * Providers read keys from process.env, so env values are bridged there
 * (best-effort; workerd may not allow writes — keyless still works because
 * absent keys degrade).
 */
import { isKeySentinel } from '../../server/standalone/keySentinel.mjs';
import { ShimReq, ShimRes } from '../../server/pages/shim.mjs';
import { buildPagesStack } from '../../server/pages/stack.mjs';

/**
 * Bridge Pages env vars into process.env for the providers (they read
 * process.env.* at request time). Sentinel/blank values are scrubbed.
 * Defensive: every step is optional — keyless works regardless.
 */
function ensureProcessEnv(env) {
  try {
    const g = globalThis;
    if (typeof g.process !== 'object' || g.process === null) g.process = {};
    const proc = g.process;
    if (typeof proc.env !== 'object' || proc.env === null) proc.env = {};
    for (const [key, value] of Object.entries(env || {})) {
      try {
        if (typeof value === 'string' && isKeySentinel(value)) {
          delete proc.env[key]; // sentinel behaves exactly like an absent key
        } else if (value !== undefined && value !== null) {
          proc.env[key] = typeof value === 'string' ? value : String(value);
        }
      } catch {
        /* env bridge is best-effort */
      }
    }
    // Disk-cache paths are built from process.cwd() inside provider
    // factories. On workerd the only writable dir is /tmp (ephemeral,
    // per-request); point cwd there so cache writes succeed-or-noop
    // instead of throwing. All disk IO in providers is try/catch'd.
    let cwdOk = false;
    try {
      proc.cwd();
      cwdOk = true;
    } catch {
      /* fall through to polyfill */
    }
    if (!cwdOk) {
      try {
        proc.cwd = () => '/tmp';
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* never let env bridging break the request */
  }
}

// Built once per isolate; isolates are reused across requests, so the
// providers' in-memory caches behave like the single Node prod-server.
let stackPromise = null;

function getStack() {
  if (!stackPromise) {
    stackPromise = buildPagesStack((msg) => {
      try {
        console.log(msg);
      } catch {
        /* ignore */
      }
    }).catch((err) => {
      stackPromise = null; // let the next request retry the build
      throw err;
    });
  }
  return stackPromise;
}

function clientIp(request) {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || 'local';
  return 'local';
}

function jsonError(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;

  ensureProcessEnv(env);

  let stack;
  try {
    ({ stack } = await getStack());
  } catch (err) {
    return jsonError(503, {
      error: 'api_unavailable',
      detail: err && err.message ? String(err.message).slice(0, 200) : String(err),
    });
  }

  const req = new ShimReq(request, clientIp(request));
  const res = new ShimRes();
  try {
    return await stack.handle(req, res);
  } catch (err) {
    return jsonError(500, { error: 'internal server error' });
  }
}
