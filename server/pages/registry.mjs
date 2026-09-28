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
  // NOTE (2026-09-28): the legacy space/launch-library.js /api/launches entry
  // was removed — it shadowed the wave6 dual-source (LL2+RocketLaunch.Live)
  // provider below, which now carries pad coordinates and is the canonical
  // route. The old module file is retained for reference only.
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
  {
    name: 'feodo',
    routes: ['/api/feodo'],
    load: () => import('../providers/wave3/feodo.js').then((m) => m.feodoProxy()),
  },
  {
    name: 'gdelt',
    routes: ['/api/gdelt'],
    load: () => import('../providers/wave3/gdelt.js').then((m) => m.gdeltProxy()),
  },
  {
    name: 'gmn-meteors',
    routes: ['/api/meteors'],
    load: () => import('../providers/wave3/gmn.js').then((m) => m.gmnProxy()),
  },
  {
    name: 'eibi',
    routes: ['/api/eibi'],
    load: () => import('../providers/wave3/eibi.js').then((m) => m.eibiProxy()),
  },
  {
    name: 'aishub',
    routes: ['/api/aishub'],
    load: () => import('../providers/wave3/aishub.js').then((m) => m.aishubProxy()),
  },
  {
    name: 'fireballs',
    routes: ['/api/fireballs'],
    load: () => import('../providers/wave3/fireballs.js').then((m) => m.fireballsProxy()),
  },
  {
    name: 'conjunctions',
    routes: ['/api/conjunctions'],
    load: () => import('../providers/wave3/socrates.js').then((m) => m.socratesProxy()),
  },
  {
    name: 'nmdb',
    routes: ['/api/nmdb'],
    load: () => import('../providers/wave3/nmdb.js').then((m) => m.nmdbProxy()),
  },
  {
    name: 'argo',
    routes: ['/api/argo'],
    load: () => import('../providers/wave3/argo.js').then((m) => m.argoProxy()),
  },
  {
    name: 'reentries',
    routes: ['/api/reentries'],
    load: () => import('../providers/wave3/reentries.js').then((m) => m.reentriesProxy()),
  },
  {
    name: 'interplanetary',
    routes: ['/api/interplanetary'],
    load: () => import('../providers/wave3/interplanetary.js').then((m) => m.interplanetaryProxy()),
  },
  {
    name: 'neo',
    routes: ['/api/neo'],
    load: () => import('../providers/wave3/neo.js').then((m) => m.neoProxy()),
  },
  {
    name: 'gravwaves',
    routes: ['/api/gravwaves'],
    load: () => import('../providers/wave3/gracedb.js').then((m) => m.gracedbProxy()),
  },
  {
    name: 'nwis-gauges',
    routes: ['/api/nwis-gauges', '/api/rivers'],
    load: () => import('../providers/wave3/nwisGauges.js').then((m) => m.nwisGaugesProxy()),
  },
  {
    name: 'nwps',
    routes: ['/api/nwps'],
    load: () => import('../providers/wave3/nwps.js').then((m) => m.nwpsProxy()),
  },
  {
    name: 'sensor-community',
    routes: ['/api/air-quality'],
    load: () => import('../providers/wave3/sensorCommunity.js').then((m) => m.sensorCommunityProxy()),
  },
  {
    name: 'swpc',
    routes: ['/api/space-weather'],
    load: () => import('../providers/wave3/swpc.js').then((m) => m.swpcProxy()),
  },
  {
    name: 'nws-alerts',
    routes: ['/api/nws-alerts'],
    load: () => import('../providers/wave3/nwsAlerts.js').then((m) => m.nwsAlertsProxy()),
  },
  {
    name: 'sigmets',
    routes: ['/api/sigmets', '/api/airports/metar', '/api/airports/taf'],
    load: () => import('../providers/wave3/sigmets.js').then((m) => m.sigmetsProxy()),
  },
  {
    name: 'dart-coupling',
    routes: ['/api/dart-coupling'],
    load: () => import('../providers/wave3/dart.js').then((m) => m.dartCouplingProxy()),
  },
  {
    name: 'water-twin',
    routes: ['/api/water-twin'],
    load: () => import('../providers/wave3/waterTwin.js').then((m) => m.waterTwinProxy()),
  },
  {
    name: 'wxstations',
    routes: ['/api/wxstations'],
    load: () => import('../providers/wave5/wxstations.js').then((m) => m.wxstationsProxy()),
  },
  {
    name: 'time',
    routes: ['/api/time'],
    load: () => import('../providers/wave5/time.js').then((m) => m.timeProxy()),
  },
  {
    name: 'quakes',
    routes: ['/api/quakes'],
    load: () => import('../providers/wave5/quakes.js').then((m) => m.quakesProxy()),
  },
  {
    name: 'felt',
    routes: ['/api/felt'],
    load: () => import('../providers/wave5/felt.js').then((m) => m.feltProxy()),
  },
  {
    name: 'hazards',
    routes: ['/api/hazards'],
    load: () => import('../providers/wave5/hazards.js').then((m) => m.hazardsProxy()),
  },
  {
    name: 'volcano',
    routes: ['/api/volcano'],
    load: () => import('../providers/wave5/volcano.js').then((m) => m.volcanoProxy()),
  },
  {
    name: 'asteroids',
    routes: ['/api/asteroids'],
    load: () => import('../providers/wave5/asteroids.js').then((m) => m.asteroidsProxy()),
  },
  {
    name: 'pota',
    routes: ['/api/pota'],
    load: () => import('../providers/wave5/pota.js').then((m) => m.potaProxy()),
  },
  {
    name: 'radio-reference',
    routes: ['/api/radio-reference'],
    load: () => import('../providers/wave5/radioReference.js').then((m) => m.radioReferenceProxy()),
  },
  {
    name: 'satnogs',
    routes: ['/api/satnogs'],
    load: () => import('../providers/wave5/satnogs.js').then((m) => m.satnogsProxy()),
  },
  {
    name: 'co2',
    routes: ['/api/co2'],
    load: () => import('../providers/wave5/co2.js').then((m) => m.co2Proxy()),
  },
  {
    name: 'uv',
    routes: ['/api/uv'],
    load: () => import('../providers/wave5/uv.js').then((m) => m.uvProxy()),
  },
  {
    name: 'markets',
    routes: ['/api/markets'],
    load: () => import('../providers/wave5/markets.js').then((m) => m.marketsProxy()),
  },
  {
    name: 'carbon',
    routes: ['/api/carbon'],
    load: () => import('../providers/wave5/carbon.js').then((m) => m.carbonProxy()),
  },
  {
    name: 'certs',
    routes: ['/api/certs'],
    load: () => import('../providers/wave5/certs.js').then((m) => m.certsProxy()),
  },
  {
    name: 'civic',
    routes: ['/api/civic'],
    load: () => import('../providers/wave5/civic.js').then((m) => m.civicProxy()),
  },
  {
    name: 'research',
    routes: ['/api/research'],
    load: () => import('../providers/wave5/research.js').then((m) => m.researchProxy()),
  },
  {
    name: 'biosphere',
    routes: ['/api/biosphere'],
    load: () => import('../providers/wave5/biosphere.js').then((m) => m.biosphereProxy()),
  },
  {
    name: 'donki',
    routes: ['/api/donki'],
    load: () => import('../providers/wave6/donki.js').then((m) => m.donkiProxy()),
  },
  {
    name: 'radiation',
    routes: ['/api/radiation'],
    load: () => import('../providers/wave6/radiation.js').then((m) => m.radiationProxy()),
  },
  {
    name: 'ripestat',
    routes: ['/api/ripestat'],
    load: () => import('../providers/wave6/ripestat.js').then((m) => m.ripestatProxy()),
  },
  {
    // Legacy collector-geo view (wave3): per-RRC pulse map for the frontier
    // layer. The wave6 provider serves country/asn/prefix queries instead;
    // this keeps the visualization's {prefixes[]} shape on its own route.
    name: 'ripestat-collectors',
    routes: ['/api/ripestat-collectors'],
    load: () => import('../providers/wave3/ripestat.js').then((m) => m.ripestatProxy({ route: '/api/ripestat-collectors' })),
  },
  {
    name: 'pskreporter',
    routes: ['/api/pskreporter'],
    load: () => import('../providers/wave6/pskreporter.js').then((m) => m.pskreporterProxy()),
  },
  {
    name: 'sondes',
    routes: ['/api/sondes'],
    load: () => import('../providers/wave6/sondes.js').then((m) => m.sondesProxy()),
  },
  {
    name: 'gliders',
    routes: ['/api/gliders'],
    load: () => import('../providers/wave6/gliders.js').then((m) => m.glidersProxy()),
  },
  {
    name: 'frequencies',
    routes: ['/api/frequencies'],
    load: () => import('../providers/wave6/frequencies.js').then((m) => m.frequenciesProxy()),
  },
  {
    name: 'ham-space',
    routes: ['/api/ham-space'],
    load: () => import('../providers/wave6/ham-space.js').then((m) => m.hamSpaceProxy()),
  },
  {
    name: 'aircraft',
    routes: ['/api/aircraft'],
    load: () => import('../providers/wave6/aircraft.js').then((m) => m.aircraftProxy()),
  },
  {
    name: 'ships',
    routes: ['/api/ships'],
    load: () => import('../providers/wave6/ships.js').then((m) => m.shipsProxy()),
  },
  {
    name: 'buoys',
    routes: ['/api/buoys'],
    load: () => import('../providers/wave6/buoys.js').then((m) => m.buoysProxy()),
  },
  {
    name: 'tides',
    routes: ['/api/tides'],
    load: () => import('../providers/wave6/tides.js').then((m) => m.tidesProxy()),
  },
  {
    name: 'whales',
    routes: ['/api/whales'],
    load: () => import('../providers/wave6/whales.js').then((m) => m.whalesProxy()),
  },
  {
    name: 'trains',
    routes: ['/api/trains'],
    load: () => import('../providers/wave6/trains.js').then((m) => m.trainsProxy()),
  },
  {
    name: 'bikeshare',
    routes: ['/api/bikeshare'],
    load: () => import('../providers/wave6/bikeshare.js').then((m) => m.bikeshareProxy()),
  },
  {
    name: 'launches',
    routes: ['/api/launches'],
    load: () => import('../providers/wave6/launches.js').then((m) => m.launchesProxy()),
  },
  {
    name: 'meteor-stations',
    routes: ['/api/meteor-stations'],
    load: () => import('../providers/wave6/meteors.js').then((m) => m.meteorsProxy()),
  },
  {
    name: 'comets',
    routes: ['/api/comets'],
    load: () => import('../providers/wave6/comets.js').then((m) => m.cometsProxy()),
  },
  {
    name: 'dsn',
    routes: ['/api/dsn'],
    load: () => import('../providers/wave6/dsn.js').then((m) => m.dsnProxy()),
  },
  {
    name: 'fires',
    routes: ['/api/fires'],
    load: () => import('../providers/wave6/fires.js').then((m) => m.firesProxy()),
  },
  {
    name: 'disasters',
    routes: ['/api/disasters'],
    load: () => import('../providers/wave6/disasters.js').then((m) => m.disastersProxy()),
  },
  {
    name: 'alerts',
    routes: ['/api/alerts'],
    load: () => import('../providers/wave6/alerts.js').then((m) => m.alertsProxy()),
  },
  {
    name: 'solar-img',
    routes: ['/api/solar-img'],
    load: () => import('../providers/wave6/solarImg.js').then((m) => m.solarImgProxy()),
  },
  {
    name: 'aurora-cams',
    routes: ['/api/aurora-cams'],
    load: () => import('../providers/wave6/auroraCams.js').then((m) => m.auroraCamsProxy()),
  },
  {
    name: 'volcano-cams',
    routes: ['/api/volcano-cams'],
    load: () => import('../providers/wave6/volcanoCams.js').then((m) => m.volcanoCamsProxy()),
  },
  {
    name: 'magnetometers',
    routes: ['/api/magnetometers'],
    load: () => import('../providers/wave6/magnetometers.js').then((m) => m.magnetometersProxy()),
  },
  {
    name: 'birdcast',
    routes: ['/api/birdcast'],
    load: () => import('../providers/wave6/birdcast.js').then((m) => m.birdcastProxy()),
  },
  {
    name: 'coral',
    routes: ['/api/coral'],
    load: () => import('../providers/wave6/coral.js').then((m) => m.coralProxy()),
  },
  {
    name: 'lightning',
    routes: ['/api/lightning'],
    load: () => import('../providers/wave6/lightning.js').then((m) => m.lightningProxy()),
  },
  {
    name: 'stations-ext',
    routes: ['/api/stations-ext'],
    load: () => import('../providers/wave6/stationsExt.js').then((m) => m.stationsExtProxy()),
  },
  {
    name: 'knowledge',
    routes: ['/api/knowledge'],
    load: () => import('../providers/wave6/knowledge.js').then((m) => m.knowledgeProxy()),
  },
  {
    name: 'sports',
    routes: ['/api/sports'],
    load: () => import('../providers/wave6/sports.js').then((m) => m.sportsProxy()),
  },
  {
    name: 'tec',
    routes: ['/api/tec'],
    load: () => import('../providers/wave7/tec.js').then((m) => m.tecProxy()),
  },
  {
    name: 'mbta',
    routes: ['/api/mbta'],
    load: () => import('../providers/wave7/mbta.js').then((m) => m.mbtaProxy()),
  },
  {
    name: 'aq-model',
    routes: ['/api/aq-model'],
    load: () => import('../providers/wave7/aqModel.js').then((m) => m.aqModelProxy()),
  },
  {
    name: 'ioos',
    routes: ['/api/ioos'],
    load: () => import('../providers/wave7/ioos.js').then((m) => m.ioosProxy()),
  },
  {
    name: 'birdcast-dash',
    routes: ['/api/birdcast-dash'],
    load: () => import('../providers/wave7/birdcast-dash.js').then((m) => m.birdcastDashProxy()),
  },
  {
    name: 'infrasound-ims',
    routes: ['/api/infrasound-ims'],
    load: () => import('../providers/wave8/infrasound.js').then((m) => m.infrasoundProxy()),
  },
  {
    name: 'geomag-usgs',
    routes: ['/api/geomag-usgs'],
    load: () => import('../providers/wave8/geomagUsgs.js').then((m) => m.geomagUsgsProxy()),
  },
  {
    name: 'icon-d2',
    routes: ['/api/icon-d2'],
    load: () => import('../providers/wave8/iconD2.js').then((m) => m.iconD2Proxy()),
  },
  {
    name: 'currents',
    routes: ['/api/currents'],
    load: () => import('../providers/wave8/currents.js').then((m) => m.currentsProxy()),
  },
  {
    name: 'gtfs-de',
    routes: ['/api/gtfs-de'],
    load: () => import('../providers/wave8/gtfsDe.js').then((m) => m.gtfsDeProxy()),
  },
  {
    name: 'nhc-gis',
    routes: ['/api/nhc-gis'],
    load: () => import('../providers/wave8/nhcGis.js').then((m) => m.nhcGisProxy()),
  },
  {
    name: 'findu',
    routes: ['/api/findu'],
    load: () => import('../providers/wave8/findu.js').then((m) => m.finduProxy()),
  },
  {
    name: 'iss-ext',
    routes: ['/api/iss-ext'],
    load: () => import('../providers/wave8/issExt.js').then((m) => m.issExtProxy()),
  },
  {
    name: 'gracedb',
    routes: ['/api/gracedb'],
    load: () => import('../providers/wave8/gracedb.js').then((m) => m.gracedbProxy()),
  },
];

export { REGISTRY };

/** Route prefixes intentionally excluded from the Pages stack (see header). */
export const EXCLUDED = [
  { name: 'ais-live', routes: ['/api/ais-live'], why: 'keyed upstream WebSocket; no key in keyless deploy' },
  { name: 'local-receivers', routes: ['/api/receivers'], why: 'LAN-local receivers unreachable from the edge' },
  { name: 'key-setup', routes: ['/api/setup/keys', '/api/setup/status'], why: 'writes local .env; no writable fs on Pages' },
];
