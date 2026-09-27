/**
 * Pages Functions provider registry for SATWQ // God's Eye.
 *
 * Mirrors server/providers/local.js (same providers, same order) but loads
 * each provider with an isolated dynamic import: if a provider's module
 * graph can't load in workerd (e.g. a 'node:' import the runtime doesn't
 * satisfy), only that provider's routes degrade to a JSON 503 — the rest
 * of /api/* keeps working. No provider files are modified.
 *
 * Deliberate exclusions (documented, not failures):
 *  - vessels/ais-live.js      — the ONLY server WebSocket (upstream
 *    wss://stream.aisstream.io) and it is keyed; a keyless Pages deploy has
 *    no AISSTREAM_API_KEY, so it is excluded by design.
 *  - local-receivers.js       — proxies LAN-local receivers (dump1090 etc.)
 *    via node:dns + node:http(s); unreachable from the edge by design.
 *  - standalone/key-setup.js  — writes provider keys to a local .env via
 *    the UI; there is no writable .env on Pages.
 *  - wind.js                  — SUPERSEDED 2026-09-27: /api/wind is served on
 *    Pages by the WASM-free snapshot provider below (windSnapshot.mjs),
 *    which serves pre-decoded GFS grids from the `wind-latest` GitHub
 *    release (published by scripts/wind-snapshot.mjs). The live GRIB
 *    decoder (@meri-imperiumi/eccodes-wasm) is still excluded from the
 *    bundle — esbuild cannot resolve its node:fs/node:path requires —
 *    so server/providers/wind.js itself is never imported here.
 *
 * Relative import paths are from THIS file (server/pages/registry.mjs).
 */

const REGISTRY = [
  {
    name: 'opensky',
    routes: ['/api/opensky'],
    load: () => import('../providers/aircraft/opensky.js').then((m) => m.openSkyProxy()),
  },
  {
    name: 'celestrak',
    routes: ['/api/celestrak'],
    load: () => import('../providers/space/celestrak.js').then((m) => m.celestrakProxy()),
  },
  {
    name: 'launches',
    routes: ['/api/launches'],
    load: () => import('../providers/space/launch-library.js').then((m) => m.rocketLaunchesProxy()),
  },
  {
    name: 'tomtom',
    routes: ['/api/tomtom'],
    load: () => import('../providers/traffic.js').then((m) => m.tomtomProxy()),
  },
  {
    name: 'firms',
    routes: ['/api/firms'],
    load: () => import('../providers/firms.js').then((m) => m.firmsProxy()),
  },
  {
    name: 'terrain',
    routes: ['/api/terrain/heights'],
    load: () => import('../providers/terrain.js').then((m) => m.terrainHeightsProxy()),
  },
  {
    name: 'adsbdb',
    routes: ['/api/adsbdb'],
    load: () => import('../providers/aircraft/enrichment.js').then((m) => m.adsbdbProxy()),
  },
  {
    name: 'overpass',
    // overpassProxy() also installs the /api/route middleware (places/routes.js).
    routes: ['/api/overpass', '/api/route'],
    load: () => import('../providers/overpass.js').then((m) => m.overpassProxy()),
  },
  {
    name: 'military-installations',
    routes: ['/api/military-installations'],
    load: () =>
      import('../providers/military-installations.js').then((m) => m.militaryInstallationsProxy()),
  },
  {
    name: 'regional-brief',
    routes: ['/api/regional-brief'],
    load: () => import('../providers/regional/briefing.js').then((m) => m.regionalBriefProxy()),
  },
  {
    name: 'geocode',
    routes: ['/api/geocode'],
    load: () => import('../providers/regional/place.js').then((m) => m.geocodeProxy()),
  },
  {
    name: 'weather-effects',
    routes: ['/api/weather-effects'],
    load: () => import('../providers/regional/weather-effects.js').then((m) => m.weatherEffectsProxy()),
  },
  {
    name: 'cctv',
    routes: ['/api/cctv'],
    load: () =>
      import('../providers/cctv.js').then(async (m) => {
        const { defaultSourceRoot } = await import('../providers/common/source-root.js');
        return m.cctvProxy({ sourceRoot: defaultSourceRoot });
      }),
  },
  {
    name: 'radio',
    routes: ['/api/radio'],
    load: () => import('../providers/radio.js').then((m) => m.radioBrowserProxy()),
  },
  {
    name: 'gbfs',
    routes: ['/api/gbfs'],
    load: () => import('../providers/gbfs.js').then((m) => m.gbfsProxy()),
  },
  {
    name: 'transit',
    routes: ['/api/transit'],
    load: () => import('../providers/transit.js').then((m) => m.transitProxy()),
  },
  {
    name: 'adsb-lol',
    routes: ['/api/adsblol/mil'],
    load: () => import('../providers/aircraft/adsb-lol.js').then((m) => m.adsbLolProxy()),
  },
  {
    name: 'track-backfill',
    routes: ['/api/adsblol/trace', '/api/opensky-track'],
    load: () => import('../providers/aircraft/tracks.js').then((m) => m.trackBackfillProxies()),
  },
  {
    name: 'hms-smoke',
    routes: ['/api/hms-smoke'],
    load: () => import('../providers/hmsSmoke.js').then((m) => m.hmsSmokeProxy()),
  },
  {
    name: 'openai',
    routes: ['/api/openai/hud-summary', '/api/realtime/debug-log', '/api/realtime/token'],
    load: () => import('../providers/openai.js').then((m) => m.openAiRealtimeProxy()),
  },
  {
    name: 'places',
    routes: ['/api/google/nearby-places', '/api/google/text-search'],
    load: () => import('../providers/places.js').then((m) => m.googlePlacesContextProxy()),
  },
  // wind served via the WASM-free snapshot provider (see header note).
  {
    name: 'wind-snapshot',
    routes: ['/api/wind'],
    load: () => import('./windSnapshot.mjs').then((m) => m.windSnapshotProxy()),
  },
  {
    name: 'weather',
    routes: ['/api/weather'],
    load: () => import('../providers/weather.js').then((m) => m.weatherProxy()),
  },
  {
    name: 'cyclones',
    routes: ['/api/cyclones'],
    load: () => import('../providers/cyclones.js').then((m) => m.cycloneProxy()),
  },
  {
    name: 'fire-perimeters',
    routes: ['/api/fire-perimeters'],
    load: () => import('../providers/firePerimeters.js').then((m) => m.firePerimetersProxy()),
  },
  {
    name: 'event-synthesis',
    routes: ['/api/events', '/api/sky-alerts'],
    load: () => import('../providers/eventSynthesis.js').then((m) => m.eventSynthesisProxy()),
  },
  {
    name: 'invisible-ocean',
    routes: ['/api/invisible-ocean/spots'],
    load: () => import('../providers/invisibleOceanProxy.js').then((m) => m.invisibleOceanProxy()),
  },
  {
    name: 'vaac',
    routes: ['/api/vaac'],
    load: () => import('../providers/vaac.js').then((m) => m.vaacProxy()),
  },
];

export { REGISTRY };

/** Route prefixes intentionally excluded from the Pages stack (see header). */
export const EXCLUDED = [
  { name: 'ais-live', routes: ['/api/ais-live'], why: 'keyed upstream WebSocket; no key in keyless deploy' },
  { name: 'local-receivers', routes: ['/api/receivers'], why: 'LAN-local receivers unreachable from the edge' },
  { name: 'key-setup', routes: ['/api/setup/keys', '/api/setup/status'], why: 'writes local .env; no writable fs on Pages' },
];
