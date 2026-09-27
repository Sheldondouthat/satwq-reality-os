/**
 * Vercel serverless adapter for the SATWQ Reality OS provider middleware.
 *
 * The prod server (server/standalone/prod-server.mjs) mounts provider plugins
 * as connect-style middleware: the route prefix is stripped from req.url
 * before the handler runs, and handlers signal fall-through with next().
 * Each Vercel function file mounts the SAME provider factory through
 * mountProvider(), which replays exactly those semantics for one (req, res)
 * invocation. No provider code is forked — the Docker/prod-server path is
 * untouched.
 *
 * Two serverless adaptations live here:
 *
 * 1. Disk caches — every provider writes its disk cache relative to
 *    process.cwd() (`.gev-cache/...`). A Vercel function's checkout is
 *    read-only, so the function retargets cwd to os.tmpdir(): all caches
 *    keep working, ephemerally, for the life of the warm instance. Repo
 *    files the providers READ (CCTV catalog, key-setup store) resolve via
 *    absolute sourceRoot values passed by each function file, so the chdir
 *    cannot misdirect them.
 *
 * 2. Key sentinel — scrubKeySentinels() runs once per function instance, so
 *    the NOT-CONFIGURED sentinel behaves exactly like an absent key. Keyless
 *    degradation on Vercel is identical to the Docker/prod-server path.
 *
 * Only configureServer is invoked (never configurePreviewServer), matching
 * prod-server.mjs. httpServer is null — no mounted provider may require it
 * (/api/ais-live is the exception, and it is rewritten as api/ais-live.js
 * instead of being mounted).
 */
import os from 'node:os';
import { scrubKeySentinels } from '../../server/standalone/keySentinel.mjs';

// Writable scratch for the per-instance disk caches (see above). Runs once
// per function instance, at import time.
try {
  process.chdir(os.tmpdir());
} catch {
  // Already there, or chdir unavailable — cache writes degrade per-provider.
}

// NOT-CONFIGURED (and blank) provider keys behave as absent keys. Idempotent.
scrubKeySentinels();

function normalizeRoute(route) {
  if (route.length > 1 && route.endsWith('/')) return route.slice(0, -1);
  return route;
}

/** JSON responder shared by the stub/rewrite function files. */
export function sendJson(res, statusCode, payload) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

/**
 * Mount one provider plugin factory and return a Vercel (req, res) handler.
 *
 * @param {() => object} pluginFactory thunk returning the Vite plugin, e.g.
 *   () => firmsProxy() or () => cctvProxy({ sourceRoot: defaultSourceRoot }).
 *   The thunk form lets each function file pass factory args exactly the way
 *   server/providers/local.js does.
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function mountProvider(pluginFactory) {
  const layers = [];
  const middlewares = {
    use(route, fn) {
      if (typeof route === 'function') {
        fn = route;
        route = '/';
      }
      layers.push({ route: normalizeRoute(route), fn });
    },
  };

  const plugin = pluginFactory();
  if (typeof plugin?.configureServer !== 'function') {
    throw new Error('[vercel-adapter] provider plugin has no configureServer');
  }
  // Prod parity: prod-server.mjs installs configureServer only.
  plugin.configureServer({ middlewares, httpServer: null });

  return async function vercelProviderHandler(req, res) {
    req.originalUrl = req.originalUrl || req.url;
    let settled = false;
    let idx = 0;

    const done = () => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    };
    let resolvePromise = () => {};

    const next = (err) => {
      if (settled || res.headersSent || res.writableEnded) return;
      // Restore the stripped prefix before trying the next layer (connect).
      req.url = req.originalUrl;

      while (idx < layers.length) {
        const layer = layers[idx++];
        if (err) {
          // Error-handling middleware takes (err, req, res, next).
          if (layer.fn.length !== 4) continue;
          invoke(layer, err);
          return;
        }
        if (layer.fn.length === 4) continue; // skip error handlers
        const pathname = String(req.url || '').split('?')[0];
        const { route } = layer;
        if (route !== '/') {
          if (!pathname.startsWith(route)) continue;
          const c = pathname[route.length];
          if (c && c !== '/' && c !== '.') continue;
        }
        invoke(layer, null);
        return;
      }

      // Nothing handled it — same JSON 404 contract as apiNotFoundPlugin.
      if (!res.headersSent) {
        if (err) {
          console.error(
            '[vercel-adapter] unhandled middleware error:',
            err?.message || err,
          );
        }
        sendJson(res, err ? 500 : 404, {
          error: err ? 'internal server error' : 'Unknown API route',
        });
      }
    };

    const invoke = (layer, err) => {
      const stripped =
        layer.route === '/'
          ? req.originalUrl
          : req.originalUrl.slice(layer.route.length) || '/';
      req.url = stripped;
      try {
        const out =
          err != null
            ? layer.fn(err, req, res, next)
            : layer.fn(req, res, next);
        if (out && typeof out.catch === 'function') out.catch(next);
      } catch (e) {
        next(e);
      }
    };

    await new Promise((resolve) => {
      resolvePromise = resolve;
      const originalEnd = res.end.bind(res);
      res.end = (...args) => {
        const result = originalEnd(...args);
        done();
        return result;
      };
      // Backstop: if a handler ever finishes without ending the response,
      // resolve on close instead of hanging the invocation.
      if (typeof res.once === 'function') res.once('close', done);
      next();
    });
  };
}
