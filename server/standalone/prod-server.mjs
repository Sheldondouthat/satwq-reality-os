#!/usr/bin/env node
/**
 * Production server for SATWQ // God's Eye — Reality OS.
 *
 * Single Node process that serves the built `dist/` bundle AND mounts the
 * exact same `/api/*` provider middleware used by the Vite dev server.
 *
 * Why not `vite preview`? The dev-only API routes are Vite *dev* middleware
 * (configureServer plugins); `vite preview` does not run them. This file
 * replays those plugins against a minimal connect-compatible middleware
 * stack on plain node:http — no express, no new dependencies.
 *
 * Usage:
 *   npm run build
 *   PORT=4173 HOST=0.0.0.0 node server/standalone/prod-server.mjs
 *   # or: npm start  (PORT defaults to 4173; the Dockerfile sets 7860)
 *
 * Env: PORT (default 4173), HOST (default 0.0.0.0). Provider API keys are
 * read from process.env (or a root .env file, same as the dev server).
 *
 * Part of the gods-eye-view checkout (MIT, see LICENSE). Upstream
 * attribution: https://github.com/bilawalsidhu/gods-eye-view
 */
import http from 'node:http';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { localProviderPlugins } from '../providers/local.js';
import { apiNotFoundPlugin } from './api-not-found.js';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ */
/* .env parity: the Vite standalone config loads root .env files via  */
/* loadEnv(); mirror that here with a tiny parser (no new deps).      */
/* ------------------------------------------------------------------ */
async function loadDotEnvFiles() {
  // Vite loadEnv order for mode=production (later files win).
  const names = ['.env', '.env.local', '.env.production', '.env.production.local'];
  for (const name of names) {
    let text;
    try {
      text = await fsp.readFile(path.join(ROOT, name), 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Connect-compatible middleware stack.                                */
/*                                                                     */
/* Every provider plugin is a Vite plugin whose configureServer does  */
/* `server.middlewares.use(route, handler)` — connect semantics: the   */
/* route prefix is stripped from req.url before the handler runs, and  */
/* handlers signal fall-through with next().                           */
/* ------------------------------------------------------------------ */
function createMiddlewareStack() {
  const layers = [];
  return {
    use(route, fn) {
      if (typeof route === 'function') {
        fn = route;
        route = '/';
      }
      if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
      layers.push({ route, fn });
    },

    handle(req, res) {
      req.originalUrl = req.originalUrl || req.url;
      let idx = 0;

      const next = (err) => {
        if (res.headersSent || res.writableEnded) return;
        // Restore the stripped prefix before trying the next layer.
        req.url = req.originalUrl;

        while (idx < layers.length) {
          const layer = layers[idx++];
          if (err) {
            // Error-handling middleware takes (err, req, res, next).
            if (layer.fn.length !== 4) continue;
            return invoke(layer, err);
          }
          if (layer.fn.length === 4) continue; // skip error handlers
          const pathname = req.url.split('?')[0];
          const { route } = layer;
          if (route !== '/') {
            if (!pathname.startsWith(route)) continue;
            const c = pathname[route.length];
            if (c && c !== '/' && c !== '.') continue;
          }
          return invoke(layer, null);
        }

        // Nothing handled it.
        if (err) {
          console.error('[prod-server] unhandled middleware error:', err?.message || err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal server error' }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
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

      next();
    },
  };
}

/* ------------------------------------------------------------------ */
/* Static file serving for dist/ with SPA fallback.                    */
/* ------------------------------------------------------------------ */
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
  ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'],
  ['.terrain', 'application/octet-stream'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.xml', 'application/xml; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function contentTypeFor(filePath) {
  return MIME.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

async function serveFile(req, res, filePath, { immutable = false } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  const headers = {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stat.size,
    'Cache-Control': immutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  const stream = (await import('node:fs')).createReadStream(filePath);
  stream.on('error', (err) => {
    console.warn('[prod-server] static read failed:', err?.message || err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
  return true;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad request');
    return;
  }
  const candidate = path.normalize(path.join(DIST, rel));
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return;
  }
  let target = candidate;
  try {
    const stat = await fsp.stat(candidate);
    if (stat.isDirectory()) target = path.join(candidate, 'index.html');
  } catch {
    /* fall through to SPA fallback */
  }
  const immutable = target.startsWith(path.join(DIST, 'assets') + path.sep);
  if (await serveFile(req, res, target, { immutable })) return;
  // SPA fallback: client-side routes resolve to the app shell.
  if (await serveFile(req, res, path.join(DIST, 'index.html'))) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

/* ------------------------------------------------------------------ */
/* Boot.                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  await loadDotEnvFiles();

  const stack = createMiddlewareStack();

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      stack.handle(req, res);
    } else {
      serveStatic(req, res, pathname).catch((err) => {
        console.warn('[prod-server] static error:', err?.message || err);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('internal server error');
        }
      });
    }
  });

  // Install the dev-identical provider stack. apiNotFoundPlugin() goes last
  // so unmatched /api/* gets a JSON 404 instead of the SPA fallback.
  const fakeViteServer = { middlewares: stack, httpServer: server };
  for (const plugin of [...localProviderPlugins(), apiNotFoundPlugin()]) {
    if (typeof plugin.configureServer === 'function') {
      plugin.configureServer(fakeViteServer);
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });
  console.log(`[prod-server] SATWQ // God's Eye listening on http://${HOST}:${PORT}`);
  console.log(`[prod-server] serving dist/ from ${DIST}`);

  const shutdown = (signal) => {
    console.log(`[prod-server] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[prod-server] fatal:', err?.message || err);
  process.exit(1);
});
