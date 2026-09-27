# SATWQ Reality OS → Cloudflare Pages Functions port

**Goal:** a permanent, free `*.pages.dev` URL serving the full app — static
`dist/` bundle + `/api/*` backed by the existing provider middleware stack,
with zero changes to provider logic.

**Status:** port complete, harness-verified locally (25/25 providers load),
committed to `main`. Dashboard deploy is a human step (see below) — no
wrangler, no tokens, no paid anything.

## Architecture

```
browser ──► Pages ──┬── static dist/* ───────────────► unlimited free static
                    │
                    │   _routes.json: only /api/* invokes the Function
                    │
                    └── functions/api/[[path]].js ──► ShimReq/ShimRes
                                                     (server/pages/shim.mjs)
                                                         │
                              ┌──────────────────────────┤ connect-style
                              ▼                          │ (req,res,next)
                     server/pages/registry.mjs            │
                     25 providers, isolated               │
                     dynamic imports                      ▼
                              ──► REAL provider middleware (unmodified)
```

- `functions/api/[[path]].js` — the Pages Function. Bridges Pages env vars
  into `process.env` (scrubbing the `NOT-CONFIGURED` sentinel exactly like
  `prod-server.mjs`), builds the stack once per isolate, adapts the fetch
  `Request` into a Node-like req/res pair, returns the materialized `Response`.
- `functions/api/index.js` — re-exports the handler so bare `/api` also works.
- `server/pages/shim.mjs` — `ShimReq` (mutable `url`, lowercased `headers`,
  `socket.remoteAddress`, both `for await` and `req.on('data')` body styles),
  `ShimRes` (`writeHead`/`setHeader`/`write`/`end`/`statusCode`/pipe emitter
  surface), and a connect-compatible middleware stack mirroring
  `prod-server.mjs` (route-prefix stripping, `next()` restore, error-handler
  layers, fail-open fall-through instead of connect's hang).
- `server/pages/registry.mjs` — the 25 providers in `local.js` order, each
  loaded via isolated dynamic `import()`. A provider whose module graph
  can't load in workerd degrades to a JSON **503**
  `{error:'provider_unavailable'}` at its own routes — one bad provider can
  never take down all of `/api/*`.
- `server/pages/stack.mjs` — assembles registry + `api-not-found` last
  (unmatched `/api/*` → JSON 404 `{error:'Unknown API route'}`, same as prod).
- `public/_routes.json` → copied to `dist/_routes.json` by the Vite build.
  `include: ["/api/*"]` only, so static requests stay on the unlimited-free
  static tier and never burn the 100k/day Functions quota.
- `public/_redirects` → `/* /index.html 200` (last rule) for SPA fallback.
  Pages applies redirect rules to static-asset responses; the `/api/*`
  Function (via `_routes.json`) is not a static response, so API calls are
  unaffected. **Verify after deploy** (see below).

## What was ported

All 25 providers from `localProviderPlugins()`, unmodified, in order:
opensky, celestrak, launches, tomtom, firms, terrain, adsbdb, overpass
(+ `/api/route` which overpass installs), military-installations,
regional-brief, geocode, weather-effects, cctv, radio, gbfs, transit,
adsb-lol, track-backfill (`/api/adsblol/trace`, `/api/opensky-track`),
hms-smoke, openai (`/api/openai/hud-summary`, `/api/realtime/token`,
`/api/realtime/debug-log`), places (`/api/google/*`), wind, weather,
cyclones, fire-perimeters.

## Deliberately excluded (not failures)

| Provider | Routes | Why |
|---|---|---|
| `vessels/ais-live.js` | `/api/ais-live` | The ONLY server WebSocket (upstream `wss://stream.aisstream.io`) and it is keyed. Keyless deploy has no `AISSTREAM_API_KEY`. No client→server WS exists, so nothing else is lost. |
| `local-receivers.js` | `/api/receivers/*` | Proxies LAN-local receivers (dump1090 etc.) via `node:dns` + `node:http(s)` — unreachable from the edge by design. |
| `standalone/key-setup.js` | `/api/setup/*` | Writes provider keys to a local `.env` through the UI — no writable filesystem on Pages. |
| `wind.js` | `/api/wind` | GRIB decoding pulls `@meri-imperiumi/eccodes-wasm`, whose `wasm/eccodes.js` does `require('path')`/`require('fs')`; the Pages Functions esbuild step cannot resolve those at bundle time (2026-09-27: three deploys failed identically). Excluded at the registry so the bundle never traces it; `/api/wind` answers JSON 404 on Pages and the frontend degrades the wind layer. |

## workerd runtime notes (read before deploy)

- **Compatibility flags (dashboard-settable, no wrangler):** Settings →
  Functions → Compatibility Flags → add `nodejs_compat` (provides
  `node:path`/`crypto`/`stream`/`util`/`url`/`buffer`, `process`, `Buffer`).
  For the disk-caching providers (firms, terrain, traffic, overpass,
  military-installations, space, cctv, radio, enrichment) also add
  `enable_nodejs_fs_module` — `node:fs` then resolves to a virtual FS where
  only `/tmp` is writable (ephemeral, per-request). All disk IO in the
  providers is already `try/catch`'d; misses fall back to the per-isolate
  memory caches and upstream fetches.
- **`process.env` bridging:** providers read `process.env.*` at request
  time. The Function copies Pages env vars there (best-effort) after
  scrubbing `NOT-CONFIGURED`/blanks. Keyless deploy ⇒ nothing bridged ⇒
  every provider degrades keyless exactly as it does in `prod-server.mjs`
  (`/api/firms` → 503 `no_key`, `/api/firms/status` → `{hasKey:false}`, …).
- **`process.cwd()`:** disk-cache paths are built from it inside provider
  factories. If workerd's `process.cwd()` is missing/throws, the Function
  points it at `/tmp` (the only writable dir). If a factory still throws,
  that provider degrades to 503 — the stack survives.
- **Timers:** `setTimeout`/`setInterval` exist in workerd; the providers'
  periodic cache flushes become per-isolate and ephemeral — harmless.
- **`node:dns`** (radio catalog, SSRF guard): support is uncertain — if the
  import fails, `/api/radio` degrades to 503 with the reason in the body.
- **CPU:** the free Workers limit is 10 ms CPU per request; the heaviest
  local path is JSON serialization of cached payloads — fine. Upstream
  fetches are IO, not CPU.

## Dashboard deploy steps (Cloudflare, free, no card)

1. **Workers & Pages → Create → Pages → Connect to Git** → select
   `Sheldondouthat/satwq-reality-os`, branch `main`.
2. Build settings:
   - Build command: `npm run build`
   - Build output directory: `dist`
   - (Root directory: repo root; Node version: leave default or set 22.)
3. **Environment variables** (Production): add each provider key you have;
   for keys you don't have enter the literal `NOT-CONFIGURED` — the
   Function scrubs it to "absent". (Keyless works: every provider degrades.)
   - `AISSTREAM_API_KEY`, `CESIUM_ION_TOKEN`, `FIRMS_MAP_KEY`,
     `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_SERVER_API_KEY`, `LL2_API_TOKEN`,
     `OPENAI_API_KEY`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`
4. **Settings → Functions → Compatibility Flags:** add `nodejs_compat`
   (and `enable_nodejs_fs_module` for the disk-caching providers).
5. **Deploy.** Permanent URL form: `https://satwq-reality-os.pages.dev`
   (project name may vary; preview deploys get `<hash>.<project>.pages.dev`).
6. **Fail-open (optional):** Settings → Runtime → Fail open/closed. "Fail
   open" keeps serving static assets if the Functions daily allowance is
   ever exhausted.

## Post-deploy verification

```bash
curl -s https://<project>.pages.dev/api/firms/status
# → {"hasKey":false,...}  (200, JSON — NOT index.html)

curl -sI https://<project>.pages.dev/api/hms-smoke | head -5
# → 200, content-type: application/vnd.google-earth.kml+xml

curl -s https://<project>.pages.dev/api/nope
# → {"error":"Unknown API route"}  (404)

curl -s https://<project>.pages.dev/some/client/route | head -c 60
# → <!doctype html>  (SPA fallback serves index.html)
```

If `/api/*` ever returns HTML instead of JSON, the `_redirects` SPA rule is
intercepting the Function — reorder so the Function wins (per Cloudflare
docs, redirect rules apply to static-asset responses; the `_routes.json`
Function invocation takes precedence for `/api/*`).

## Local harness transcript (2026-09-27, plain Node — no workerd here)

`node /tmp/pages-harness.mjs` → synthetic fetch Requests through the real
`onRequest()`:

```
firms/status -> 200 application/json {"hasKey":false,"lastFetch":null,"count":null,"stale":false,"ttlMs":1800000,"transactions":null}
PASS  firms/status 200
PASS  firms/status JSON
PASS  firms/status hasKey:false
hms-smoke -> 200 application/vnd.google-earth.kml+xml bodyBytes=88764
PASS  hms-smoke 200 KML
/api/nope -> 404 application/json {"error":"Unknown API route"}
PASS  unknown-api 404
PASS  unknown-api JSON shape
POST /api/overpass -> 400 application/json {"error":"Missing Overpass query body"}
PASS  overpass empty-body 400
PASS  overpass 400 JSON

HARNESS: ALL PASS
```

Provider load audit (`buildPagesStack()` in Node): **25/25 live, 0 degraded**.
In workerd, any provider whose `node:` imports can't load degrades to a
per-route JSON 503 instead of failing the deploy.

## Why not the other free hosts

- **Back4App:** free URL is temporary (60 min) — a deploy isn't done until
  the URL is permanent.
- **SnapDeploy:** free tier hard-blocks WebSocket apps behind the $12/mo
  Always-On upsell — and the app's only WS is server→AISStream anyway.
- **Glitch:** ended user-app hosting (glitch.me) in July 2025.
- Cloudflare Pages free: unlimited static bandwidth, 100k Functions
  requests/day, permanent `*.pages.dev` URL, no card. The app needs none of
  the paid bits.
