/**
 * Cloudflare Pages Functions shim for the SATWQ // God's Eye provider stack.
 *
 * The providers in ../providers/ are written as connect-style middleware:
 *   (req, res, next) => ...   with Node's req/res surface.
 * This module adapts a Web `Request` into a minimal Node-like req/res pair
 * and runs the REAL provider stack through it — no provider logic is
 * rewritten or reimplemented here.
 *
 * Workerd safety: this file uses only Web-standard APIs and plain JS.
 * It imports nothing from 'node:*'.
 */

/* ------------------------------------------------------------------ */
/* Tiny event emitter (providers use req.on('data'|'end'|'error') and   */
/* Node's Readable.pipe() calls dest.on/.emit for 'pipe'/'unpipe').     */
/* ------------------------------------------------------------------ */
function makeEmitter() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push({ fn, once: false });
      return this;
    },
    once(type, fn) {
      if (!map.has(type)) map.set(type, []);
      map.get(type).push({ fn, once: true });
      return this;
    },
    removeListener(type, fn) {
      const list = map.get(type);
      if (list) {
        const i = list.findIndex((e) => e.fn === fn);
        if (i >= 0) list.splice(i, 1);
      }
      return this;
    },
    emit(type, ...args) {
      const list = map.get(type);
      if (!list || !list.length) return false;
      for (const entry of list.slice()) {
        if (entry.once) {
          const i = list.indexOf(entry);
          if (i >= 0) list.splice(i, 1);
        }
        try {
          entry.fn(...args);
        } catch {
          /* listener errors must not break the stream */
        }
      }
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */
/* ShimReq: Node-like IncomingMessage over a fetch Request.             */
/* Supports both body styles providers use:                            */
/*   for await (const chunk of req)   (common/request.js)               */
/*   req.on('data'|'end'|'error')      (common/request.js)               */
/* ------------------------------------------------------------------ */
const BODY_CHUNK = 64 * 1024;

export class ShimReq {
  constructor(fetchReq, clientIp) {
    const url = new URL(fetchReq.url);
    this.originalUrl = url.pathname + url.search;
    this.url = this.originalUrl; // connect-style: middleware strips prefixes
    this.method = (fetchReq.method || 'GET').toUpperCase();
    this.headers = {};
    fetchReq.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      // Node joins duplicate headers with ', ' (except set-cookie).
      this.headers[k] = this.headers[k] === undefined ? value : `${this.headers[k]}, ${value}`;
    });
    // connect/Express style: rate limiters read req.socket.remoteAddress.
    this.socket = { remoteAddress: clientIp || 'local' };
    this._emitter = makeEmitter();
    this._bodyPromise = null;
    if (this.method !== 'GET' && this.method !== 'HEAD' && fetchReq.body) {
      this._bodyPromise = fetchReq.arrayBuffer().catch(() => new ArrayBuffer(0));
    } else {
      this._bodyPromise = Promise.resolve(new ArrayBuffer(0));
    }
    this._pumped = false;
  }

  on(type, fn) { this._emitter.on(type, fn); this._ensurePumped(); return this; }
  once(type, fn) { this._emitter.once(type, fn); this._ensurePumped(); return this; }
  removeListener(type, fn) { this._emitter.removeListener(type, fn); return this; }
  emit(type, ...args) { return this._emitter.emit(type, ...args); }

  _ensurePumped() {
    if (this._pumped) return;
    this._pumped = true;
    // Pump on a microtask so handlers can attach listeners synchronously first.
    this._bodyPromise.then(
      (buf) => {
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += BODY_CHUNK) {
          this._emitter.emit('data', bytes.subarray(i, i + BODY_CHUNK));
        }
        this._emitter.emit('end');
      },
      (err) => this._emitter.emit('error', err),
    );
  }

  async *[Symbol.asyncIterator]() {
    const buf = new Uint8Array(await this._bodyPromise);
    for (let i = 0; i < buf.length; i += BODY_CHUNK) {
      yield buf.subarray(i, i + BODY_CHUNK);
    }
  }
}

/* ------------------------------------------------------------------ */
/* ShimRes: Node-like ServerResponse that materializes a fetch Response.*/
/* Supports res.writeHead / setHeader / write / end / statusCode, plus  */
/* the emitter surface Readable.pipe() needs (cctv streams images).     */
/* ------------------------------------------------------------------ */
export class ShimRes {
  constructor() {
    this.statusCode = 200;
    this._headers = new Map(); // lower-cased name -> string | string[]
    this.headersSent = false;
    this.writableEnded = false;
    this._chunks = [];
    this._emitter = makeEmitter();
  }

  on(type, fn) { this._emitter.on(type, fn); return this; }
  once(type, fn) { this._emitter.once(type, fn); return this; }
  removeListener(type, fn) { this._emitter.removeListener(type, fn); return this; }
  emit(type, ...args) { return this._emitter.emit(type, ...args); }

  setHeader(name, value) {
    if (this.headersSent) return this;
    this._headers.set(String(name).toLowerCase(), value);
    return this;
  }
  getHeader(name) {
    const v = this._headers.get(String(name).toLowerCase());
    return v === undefined ? undefined : v;
  }
  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
    return this;
  }
  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }

  writeHead(status, headers) {
    this.statusCode = status;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) this.setHeader(k, v);
    }
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    if (chunk !== undefined && chunk !== null) this._chunks.push(toUint8(chunk));
    return true; // no backpressure in the materialized model
  }

  end(chunk) {
    if (this.writableEnded) return this;
    if (chunk !== undefined && chunk !== null) this._chunks.push(toUint8(chunk));
    this.writableEnded = true;
    this.headersSent = true;
    this._emitter.emit('finish');
    return this;
  }

  toResponse() {
    const headers = new Headers();
    for (const [k, v] of this._headers) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, String(item));
      } else if (v !== undefined) {
        headers.set(k, String(v));
      }
    }
    let body = null;
    if (this._chunks.length) {
      const total = this._chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of this._chunks) {
        merged.set(c, off);
        off += c.length;
      }
      body = merged;
    }
    return new Response(body, { status: this.statusCode, headers });
  }
}

function toUint8(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  return new TextEncoder().encode(String(chunk));
}

/* ------------------------------------------------------------------ */
/* Connect-compatible middleware stack (mirrors prod-server.mjs).      */
/* Route prefixes are stripped from req.url before the handler runs;   */
/* next() restores req.url and tries the next layer.                   */
/* ------------------------------------------------------------------ */
export function createMiddlewareStack() {
  const layers = [];
  const stack = {
    use(route, fn) {
      if (typeof route === 'function') {
        fn = route;
        route = '/';
      }
      if (route.length > 1 && route.endsWith('/')) route = route.slice(0, -1);
      layers.push({ route, fn });
    },

    /** Run the stack; resolves to the materialized fetch Response. */
    handle(req, res) {
      return new Promise((resolve) => {
        req.originalUrl = req.originalUrl || req.url;
        let idx = 0;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve(res.toResponse());
        };

        const next = (err) => {
          if (res.writableEnded) {
            done();
            return;
          }
          req.url = req.originalUrl;
          while (idx < layers.length) {
            const layer = layers[idx++];
            if (err) {
              if (layer.fn.length !== 4) continue;
              invoke(layer, err);
              return;
            }
            if (layer.fn.length === 4) continue;
            const pathname = req.url.split('?')[0];
            const { route } = layer;
            if (route !== '/') {
              if (!pathname.startsWith(route)) continue;
              const c = pathname[route.length];
              if (c && c !== '/' && c !== '.') continue;
            }
            invoke(layer, null);
            return;
          }
          if (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal server error' }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'not found' }));
          }
          done();
        };

        const invoke = (layer, err) => {
          const stripped =
            layer.route === '/'
              ? req.originalUrl
              : req.originalUrl.slice(layer.route.length) || '/';
          req.url = stripped;
          // Connect handlers must call next() at most once; guard against
          // double-advance when a handler both calls next() and returns.
          let nextCalled = false;
          const layerNext = (e) => {
            if (nextCalled) return;
            nextCalled = true;
            next(e);
          };
          let out;
          try {
            out =
              err != null
                ? layer.fn(err, req, res, layerNext)
                : layer.fn(req, res, layerNext);
          } catch (e) {
            layerNext(e);
            return;
          }
          if (out && typeof out.then === 'function') {
            out.then(
              () => {
                // Async handler settled. If it neither ended the response
                // nor called next(), fail open to the next layer instead of
                // hanging (connect would hang here; we don't).
                if (!res.writableEnded && !nextCalled) layerNext();
                else done();
              },
              (e) => layerNext(e),
            );
          } else if (!res.writableEnded && !nextCalled) {
            // Sync handler returned without ending or calling next().
            // One tick of grace in case it ends asynchronously, then fall through.
            setTimeout(() => {
              if (!settled && !res.writableEnded && !nextCalled) layerNext();
              else done();
            }, 0);
          } else {
            done();
          }
        };

        // Resolve as soon as any handler ends the response (sync or async).
        const origEnd = res.end.bind(res);
        res.end = (...args) => {
          const r = origEnd(...args);
          done();
          return r;
        };

        next();
      });
    },
  };
  return stack;
}

/**
 * Register a degradation handler for routes whose provider could not be
 * loaded in this runtime (e.g. a node: import workerd can't satisfy).
 * The rest of the stack keeps working — one bad provider never kills /api/*.
 */
export function useDegraded(stack, routes, providerName, reason) {
  for (const route of routes) {
    stack.use(route, (_req, res) => {
      res.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(
        JSON.stringify({
          error: 'provider_unavailable',
          provider: providerName,
          reason,
        }),
      );
    });
  }
}
