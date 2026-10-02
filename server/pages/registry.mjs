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
 *  - wave5/phoneSensors.js    — EXCLUDED 2026-09-30 (Build 4, R2-24): the S21
 *    barometer feed reads the VM-local poller state file; the phone's live
 *    data never leaves the VM by design, and the pressure-only public shape
 *    carries no coordinates. The full feed (pressure + position dot) serves
 *    ONLY from the private key-gated ONE PULSE plane. Same exclusion class
 *    as local-receivers.
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
  {
    name: 'nexrad',
    routes: ['/api/nexrad'],
    load: () => import('../providers/wave9/nexrad.js').then((m) => m.nexradProxy()),
  },
  {
    name: 'goes',
    routes: ['/api/goes'],
    load: () => import('../providers/wave9/goes.js').then((m) => m.goesProxy()),
  },
  {
    name: 'snotel',
    routes: ['/api/snotel'],
    load: () => import('../providers/wave9/snotel.js').then((m) => m.snotelProxy()),
  },
  {
    name: 'usdm',
    routes: ['/api/usdm'],
    load: () => import('../providers/wave9/usdm.js').then((m) => m.usdmProxy()),
  },
  {
    name: 'exoplanets',
    routes: ['/api/exoplanets'],
    load: () => import('../providers/wave9/exoplanets.js').then((m) => m.exoplanetsProxy()),
  },
  {
    name: 'pollen',
    routes: ['/api/pollen'],
    load: () => import('../providers/wave9/pollen.js').then((m) => m.pollenProxy()),
  },
  {
    name: 'hab',
    routes: ['/api/hab'],
    load: () => import('../providers/wave9/hab.js').then((m) => m.habProxy()),
  },
  {
    name: 'usace',
    routes: ['/api/usace'],
    load: () => import('../providers/wave9/usace.js').then((m) => m.usaceProxy()),
  },
  {
    name: 'great-lakes',
    routes: ['/api/great-lakes'],
    load: () => import('../providers/wave9/greatLakes.js').then((m) => m.greatLakesProxy()),
  },
  {
    name: 'ocearch',
    routes: ['/api/ocearch'],
    load: () => import('../providers/wave9/ocearch.js').then((m) => m.ocearchProxy()),
  },
  {
    name: 'coops-airpressure-sf',
    routes: ['/api/coops-airpressure-sf'],
    load: () => import('../providers/wave10/specs/coops-airpressure-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-airpressure-sf', s.SPEC);
    }),
  },
  {
    name: 'coops-airtemp-sf',
    routes: ['/api/coops-airtemp-sf'],
    load: () => import('../providers/wave10/specs/coops-airtemp-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-airtemp-sf', s.SPEC);
    }),
  },
  {
    name: 'coops-tides-sf',
    routes: ['/api/coops-tides-sf'],
    load: () => import('../providers/wave10/specs/coops-tides-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-tides-sf', s.SPEC);
    }),
  },
  {
    name: 'coops-tides-virginiakey',
    routes: ['/api/coops-tides-virginiakey'],
    load: () => import('../providers/wave10/specs/coops-tides-virginiakey.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-tides-virginiakey', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-baltimore',
    routes: ['/api/coops-waterlevel-baltimore'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-baltimore.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-baltimore', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-charleston',
    routes: ['/api/coops-waterlevel-charleston'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-charleston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-charleston', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-galveston',
    routes: ['/api/coops-waterlevel-galveston'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-galveston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-galveston', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-honolulu',
    routes: ['/api/coops-waterlevel-honolulu'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-honolulu.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-honolulu', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-newport',
    routes: ['/api/coops-waterlevel-newport'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-newport.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-newport', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-sandyhook',
    routes: ['/api/coops-waterlevel-sandyhook'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-sandyhook.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-sandyhook', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-santabarbara',
    routes: ['/api/coops-waterlevel-santabarbara'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-santabarbara.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-santabarbara', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-seattle',
    routes: ['/api/coops-waterlevel-seattle'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-seattle.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-seattle', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-sf',
    routes: ['/api/coops-waterlevel-sf'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-sf', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-virginiakey',
    routes: ['/api/coops-waterlevel-virginiakey'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-virginiakey.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-virginiakey', s.SPEC);
    }),
  },
  {
    name: 'coops-watertemp-virginiakey',
    routes: ['/api/coops-watertemp-virginiakey'],
    load: () => import('../providers/wave10/specs/coops-watertemp-virginiakey.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-watertemp-virginiakey', s.SPEC);
    }),
  },
  {
    name: 'coops-wind-sf',
    routes: ['/api/coops-wind-sf'],
    load: () => import('../providers/wave10/specs/coops-wind-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-wind-sf', s.SPEC);
    }),
  },
  {
    name: 'fda-drug-shortages',
    routes: ['/api/fda-drug-shortages'],
    load: () => import('../providers/wave10/specs/fda-drug-shortages.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('fda-drug-shortages', s.SPEC);
    }),
  },
  {
    name: 'metno-atlanta',
    routes: ['/api/metno-atlanta'],
    load: () => import('../providers/wave10/specs/metno-atlanta.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-atlanta', s.SPEC);
    }),
  },
  {
    name: 'metno-boston',
    routes: ['/api/metno-boston'],
    load: () => import('../providers/wave10/specs/metno-boston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-boston', s.SPEC);
    }),
  },
  {
    name: 'metno-chicago',
    routes: ['/api/metno-chicago'],
    load: () => import('../providers/wave10/specs/metno-chicago.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-chicago', s.SPEC);
    }),
  },
  {
    name: 'metno-dallas',
    routes: ['/api/metno-dallas'],
    load: () => import('../providers/wave10/specs/metno-dallas.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-dallas', s.SPEC);
    }),
  },
  {
    name: 'metno-dc',
    routes: ['/api/metno-dc'],
    load: () => import('../providers/wave10/specs/metno-dc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-dc', s.SPEC);
    }),
  },
  {
    name: 'metno-denver',
    routes: ['/api/metno-denver'],
    load: () => import('../providers/wave10/specs/metno-denver.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-denver', s.SPEC);
    }),
  },
  {
    name: 'metno-houston',
    routes: ['/api/metno-houston'],
    load: () => import('../providers/wave10/specs/metno-houston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-houston', s.SPEC);
    }),
  },
  {
    name: 'metno-la',
    routes: ['/api/metno-la'],
    load: () => import('../providers/wave10/specs/metno-la.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-la', s.SPEC);
    }),
  },
  {
    name: 'metno-miami',
    routes: ['/api/metno-miami'],
    load: () => import('../providers/wave10/specs/metno-miami.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-miami', s.SPEC);
    }),
  },
  {
    name: 'metno-minneapolis',
    routes: ['/api/metno-minneapolis'],
    load: () => import('../providers/wave10/specs/metno-minneapolis.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-minneapolis', s.SPEC);
    }),
  },
  {
    name: 'metno-nyc',
    routes: ['/api/metno-nyc'],
    load: () => import('../providers/wave10/specs/metno-nyc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-nyc', s.SPEC);
    }),
  },
  {
    name: 'metno-phoenix',
    routes: ['/api/metno-phoenix'],
    load: () => import('../providers/wave10/specs/metno-phoenix.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-phoenix', s.SPEC);
    }),
  },
  {
    name: 'metno-portland',
    routes: ['/api/metno-portland'],
    load: () => import('../providers/wave10/specs/metno-portland.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-portland', s.SPEC);
    }),
  },
  {
    name: 'metno-seattle',
    routes: ['/api/metno-seattle'],
    load: () => import('../providers/wave10/specs/metno-seattle.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-seattle', s.SPEC);
    }),
  },
  {
    name: 'metno-sf',
    routes: ['/api/metno-sf'],
    load: () => import('../providers/wave10/specs/metno-sf.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-sf', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-ca',
    routes: ['/api/nws-alerts-ca'],
    load: () => import('../providers/wave10/specs/nws-alerts-ca.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-ca', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-co',
    routes: ['/api/nws-alerts-co'],
    load: () => import('../providers/wave10/specs/nws-alerts-co.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-co', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-fl',
    routes: ['/api/nws-alerts-fl'],
    load: () => import('../providers/wave10/specs/nws-alerts-fl.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-fl', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-ks',
    routes: ['/api/nws-alerts-ks'],
    load: () => import('../providers/wave10/specs/nws-alerts-ks.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-ks', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-ok',
    routes: ['/api/nws-alerts-ok'],
    load: () => import('../providers/wave10/specs/nws-alerts-ok.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-ok', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-tx',
    routes: ['/api/nws-alerts-tx'],
    load: () => import('../providers/wave10/specs/nws-alerts-tx.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-tx', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-chicago',
    routes: ['/api/nws-forecast-chicago'],
    load: () => import('../providers/wave10/specs/nws-forecast-chicago.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-chicago', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-dallas',
    routes: ['/api/nws-forecast-dallas'],
    load: () => import('../providers/wave10/specs/nws-forecast-dallas.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-dallas', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-dc',
    routes: ['/api/nws-forecast-dc'],
    load: () => import('../providers/wave10/specs/nws-forecast-dc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-dc', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-denver',
    routes: ['/api/nws-forecast-denver'],
    load: () => import('../providers/wave10/specs/nws-forecast-denver.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-denver', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-houston',
    routes: ['/api/nws-forecast-houston'],
    load: () => import('../providers/wave10/specs/nws-forecast-houston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-houston', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-kansascity',
    routes: ['/api/nws-forecast-kansascity'],
    load: () => import('../providers/wave10/specs/nws-forecast-kansascity.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-kansascity', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-miami',
    routes: ['/api/nws-forecast-miami'],
    load: () => import('../providers/wave10/specs/nws-forecast-miami.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-miami', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-nyc',
    routes: ['/api/nws-forecast-nyc'],
    load: () => import('../providers/wave10/specs/nws-forecast-nyc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-nyc', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-phoenix',
    routes: ['/api/nws-forecast-phoenix'],
    load: () => import('../providers/wave10/specs/nws-forecast-phoenix.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-phoenix', s.SPEC);
    }),
  },
  {
    name: 'nws-forecast-seattle',
    routes: ['/api/nws-forecast-seattle'],
    load: () => import('../providers/wave10/specs/nws-forecast-seattle.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-forecast-seattle', s.SPEC);
    }),
  },
  {
    name: 'smhi-amsterdam',
    routes: ['/api/smhi-amsterdam'],
    load: () => import('../providers/wave10/specs/smhi-amsterdam.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-amsterdam', s.SPEC);
    }),
  },
  {
    name: 'smhi-berlin',
    routes: ['/api/smhi-berlin'],
    load: () => import('../providers/wave10/specs/smhi-berlin.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-berlin', s.SPEC);
    }),
  },
  {
    name: 'smhi-copenhagen',
    routes: ['/api/smhi-copenhagen'],
    load: () => import('../providers/wave10/specs/smhi-copenhagen.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-copenhagen', s.SPEC);
    }),
  },
  {
    name: 'smhi-gothenburg',
    routes: ['/api/smhi-gothenburg'],
    load: () => import('../providers/wave10/specs/smhi-gothenburg.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-gothenburg', s.SPEC);
    }),
  },
  {
    name: 'smhi-hamburg',
    routes: ['/api/smhi-hamburg'],
    load: () => import('../providers/wave10/specs/smhi-hamburg.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-hamburg', s.SPEC);
    }),
  },
  {
    name: 'smhi-helsinki',
    routes: ['/api/smhi-helsinki'],
    load: () => import('../providers/wave10/specs/smhi-helsinki.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-helsinki', s.SPEC);
    }),
  },
  {
    name: 'smhi-london',
    routes: ['/api/smhi-london'],
    load: () => import('../providers/wave10/specs/smhi-london.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-london', s.SPEC);
    }),
  },
  {
    name: 'smhi-oslo',
    routes: ['/api/smhi-oslo'],
    load: () => import('../providers/wave10/specs/smhi-oslo.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-oslo', s.SPEC);
    }),
  },
  {
    name: 'smhi-stockholm',
    routes: ['/api/smhi-stockholm'],
    load: () => import('../providers/wave10/specs/smhi-stockholm.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-stockholm', s.SPEC);
    }),
  },
  {
    name: 'smhi-warsaw',
    routes: ['/api/smhi-warsaw'],
    load: () => import('../providers/wave10/specs/smhi-warsaw.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('smhi-warsaw', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-311',
    routes: ['/api/socrata-nyc-311'],
    load: () => import('../providers/wave10/specs/socrata-nyc-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-311', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-crime',
    routes: ['/api/socrata-nyc-crime'],
    load: () => import('../providers/wave10/specs/socrata-nyc-crime.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-crime', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-dob-permits',
    routes: ['/api/socrata-nyc-dob-permits'],
    load: () => import('../providers/wave10/specs/socrata-nyc-dob-permits.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-dob-permits', s.SPEC);
    }),
  },
  {
    name: 'socrata-sf-311',
    routes: ['/api/socrata-sf-311'],
    load: () => import('../providers/wave10/specs/socrata-sf-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-sf-311', s.SPEC);
    }),
  },
  {
    name: 'usgs-sig-quakes',
    routes: ['/api/usgs-sig-quakes'],
    load: () => import('../providers/wave10/specs/usgs-sig-quakes.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-sig-quakes', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-colorado-flow',
    routes: ['/api/usgs-water-colorado-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-colorado-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-colorado-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-columbia-flow',
    routes: ['/api/usgs-water-columbia-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-columbia-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-columbia-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-delaware-flow',
    routes: ['/api/usgs-water-delaware-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-delaware-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-delaware-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-dv-major-rivers',
    routes: ['/api/usgs-water-dv-major-rivers'],
    load: () => import('../providers/wave10/specs/usgs-water-dv-major-rivers.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-dv-major-rivers', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-hudson-flow',
    routes: ['/api/usgs-water-hudson-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-hudson-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-hudson-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-mississippi-flow',
    routes: ['/api/usgs-water-mississippi-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-mississippi-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-mississippi-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-missouri-flow',
    routes: ['/api/usgs-water-missouri-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-missouri-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-missouri-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-ohio-flow',
    routes: ['/api/usgs-water-ohio-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-ohio-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-ohio-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-potomac-flow',
    routes: ['/api/usgs-water-potomac-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-potomac-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-potomac-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-rio-grande-flow',
    routes: ['/api/usgs-water-rio-grande-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-rio-grande-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-rio-grande-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-susquehanna-flow',
    routes: ['/api/usgs-water-susquehanna-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-susquehanna-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-susquehanna-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-temp-midatlantic',
    routes: ['/api/usgs-water-temp-midatlantic'],
    load: () => import('../providers/wave10/specs/usgs-water-temp-midatlantic.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-temp-midatlantic', s.SPEC);
    }),
  },
  {
    name: 'faaDelays',
    routes: ['/api/faa-delays'],
    load: () => import('../providers/wave9/faaDelays.js').then((m) => m.faaDelaysProxy()),
  },
  {
    name: 'mirova',
    routes: ['/api/mirova'],
    load: () => import('../providers/wave9/mirova.js').then((m) => m.mirovaProxy()),
  },
  {
    name: 'fda-device-recalls',
    routes: ['/api/fda-device-recalls'],
    load: () => import('../providers/wave10/specs/fda-device-recalls.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('fda-device-recalls', s.SPEC);
    }),
  },
  {
    name: 'fda-drug-recalls',
    routes: ['/api/fda-drug-recalls'],
    load: () => import('../providers/wave10/specs/fda-drug-recalls.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('fda-drug-recalls', s.SPEC);
    }),
  },
  {
    name: 'fda-food-recalls',
    routes: ['/api/fda-food-recalls'],
    load: () => import('../providers/wave10/specs/fda-food-recalls.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('fda-food-recalls', s.SPEC);
    }),
  },
  {
    name: 'metno-madrid',
    routes: ['/api/metno-madrid'],
    load: () => import('../providers/wave10/specs/metno-madrid.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-madrid', s.SPEC);
    }),
  },
  {
    name: 'metno-paris',
    routes: ['/api/metno-paris'],
    load: () => import('../providers/wave10/specs/metno-paris.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-paris', s.SPEC);
    }),
  },
  {
    name: 'metno-reykjavik',
    routes: ['/api/metno-reykjavik'],
    load: () => import('../providers/wave10/specs/metno-reykjavik.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-reykjavik', s.SPEC);
    }),
  },
  {
    name: 'metno-rome',
    routes: ['/api/metno-rome'],
    load: () => import('../providers/wave10/specs/metno-rome.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('metno-rome', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-ny',
    routes: ['/api/nws-alerts-ny'],
    load: () => import('../providers/wave10/specs/nws-alerts-ny.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-ny', s.SPEC);
    }),
  },
  {
    name: 'nws-alerts-wa',
    routes: ['/api/nws-alerts-wa'],
    load: () => import('../providers/wave10/specs/nws-alerts-wa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-alerts-wa', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-chicago',
    routes: ['/api/nws-hourly-chicago'],
    load: () => import('../providers/wave10/specs/nws-hourly-chicago.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-chicago', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-dallas',
    routes: ['/api/nws-hourly-dallas'],
    load: () => import('../providers/wave10/specs/nws-hourly-dallas.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-dallas', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-dc',
    routes: ['/api/nws-hourly-dc'],
    load: () => import('../providers/wave10/specs/nws-hourly-dc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-dc', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-denver',
    routes: ['/api/nws-hourly-denver'],
    load: () => import('../providers/wave10/specs/nws-hourly-denver.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-denver', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-houston',
    routes: ['/api/nws-hourly-houston'],
    load: () => import('../providers/wave10/specs/nws-hourly-houston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-houston', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-kansascity',
    routes: ['/api/nws-hourly-kansascity'],
    load: () => import('../providers/wave10/specs/nws-hourly-kansascity.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-kansascity', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-miami',
    routes: ['/api/nws-hourly-miami'],
    load: () => import('../providers/wave10/specs/nws-hourly-miami.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-miami', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-nyc',
    routes: ['/api/nws-hourly-nyc'],
    load: () => import('../providers/wave10/specs/nws-hourly-nyc.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-nyc', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-phoenix',
    routes: ['/api/nws-hourly-phoenix'],
    load: () => import('../providers/wave10/specs/nws-hourly-phoenix.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-phoenix', s.SPEC);
    }),
  },
  {
    name: 'nws-hourly-seattle',
    routes: ['/api/nws-hourly-seattle'],
    load: () => import('../providers/wave10/specs/nws-hourly-seattle.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('nws-hourly-seattle', s.SPEC);
    }),
  },
  {
    name: 'socrata-chicago-crashes',
    routes: ['/api/socrata-chicago-crashes'],
    load: () => import('../providers/wave10/specs/socrata-chicago-crashes.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-chicago-crashes', s.SPEC);
    }),
  },
  {
    name: 'socrata-chicago-crime',
    routes: ['/api/socrata-chicago-crime'],
    load: () => import('../providers/wave10/specs/socrata-chicago-crime.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-chicago-crime', s.SPEC);
    }),
  },
  {
    name: 'socrata-chicago-food',
    routes: ['/api/socrata-chicago-food'],
    load: () => import('../providers/wave10/specs/socrata-chicago-food.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-chicago-food', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-crashes',
    routes: ['/api/socrata-nyc-crashes'],
    load: () => import('../providers/wave10/specs/socrata-nyc-crashes.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-crashes', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-evictions',
    routes: ['/api/socrata-nyc-evictions'],
    load: () => import('../providers/wave10/specs/socrata-nyc-evictions.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-evictions', s.SPEC);
    }),
  },
  {
    name: 'socrata-nyc-restaurants',
    routes: ['/api/socrata-nyc-restaurants'],
    load: () => import('../providers/wave10/specs/socrata-nyc-restaurants.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-nyc-restaurants', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-newriver-valley',
    routes: ['/api/usgs-water-newriver-valley'],
    load: () => import('../providers/wave10/specs/usgs-water-newriver-valley.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-newriver-valley', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-potomac-stage',
    routes: ['/api/usgs-water-potomac-stage'],
    load: () => import('../providers/wave10/specs/usgs-water-potomac-stage.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-potomac-stage', s.SPEC);
    }),
  },
  {
    name: 'surf',
    routes: ['/api/surf'],
    load: () => import('../providers/wave9/surf.js').then((m) => m.surfProxy()),
  },
  {
    name: 'coops-airpressure-nome',
    routes: ['/api/coops-airpressure-nome'],
    load: () => import('../providers/wave10/specs/coops-airpressure-nome.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-airpressure-nome', s.SPEC);
    }),
  },
  {
    name: 'coops-airtemp-boston',
    routes: ['/api/coops-airtemp-boston'],
    load: () => import('../providers/wave10/specs/coops-airtemp-boston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-airtemp-boston', s.SPEC);
    }),
  },
  {
    name: 'coops-tides-boston',
    routes: ['/api/coops-tides-boston'],
    load: () => import('../providers/wave10/specs/coops-tides-boston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-tides-boston', s.SPEC);
    }),
  },
  {
    name: 'coops-tides-sandiego',
    routes: ['/api/coops-tides-sandiego'],
    load: () => import('../providers/wave10/specs/coops-tides-sandiego.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-tides-sandiego', s.SPEC);
    }),
  },
  {
    name: 'coops-tides-seattle',
    routes: ['/api/coops-tides-seattle'],
    load: () => import('../providers/wave10/specs/coops-tides-seattle.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-tides-seattle', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-atlanticcity',
    routes: ['/api/coops-waterlevel-atlanticcity'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-atlanticcity.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-atlanticcity', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-boston',
    routes: ['/api/coops-waterlevel-boston'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-boston.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-boston', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-keywest',
    routes: ['/api/coops-waterlevel-keywest'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-keywest.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-keywest', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-losangeles',
    routes: ['/api/coops-waterlevel-losangeles'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-losangeles.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-losangeles', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-montauk',
    routes: ['/api/coops-waterlevel-montauk'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-montauk.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-montauk', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-nome',
    routes: ['/api/coops-waterlevel-nome'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-nome.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-nome', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-nybattery',
    routes: ['/api/coops-waterlevel-nybattery'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-nybattery.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-nybattery', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-portlandme',
    routes: ['/api/coops-waterlevel-portlandme'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-portlandme.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-portlandme', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-sandiego',
    routes: ['/api/coops-waterlevel-sandiego'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-sandiego.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-sandiego', s.SPEC);
    }),
  },
  {
    name: 'coops-watertemp-sandiego',
    routes: ['/api/coops-watertemp-sandiego'],
    load: () => import('../providers/wave10/specs/coops-watertemp-sandiego.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-watertemp-sandiego', s.SPEC);
    }),
  },
  {
    name: 'coops-wind-keywest',
    routes: ['/api/coops-wind-keywest'],
    load: () => import('../providers/wave10/specs/coops-wind-keywest.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-wind-keywest', s.SPEC);
    }),
  },
  {
    name: 'coops-wind-montauk',
    routes: ['/api/coops-wind-montauk'],
    load: () => import('../providers/wave10/specs/coops-wind-montauk.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-wind-montauk', s.SPEC);
    }),
  },
  {
    name: 'socrata-austin-traffic',
    routes: ['/api/socrata-austin-traffic'],
    load: () => import('../providers/wave10/specs/socrata-austin-traffic.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-austin-traffic', s.SPEC);
    }),
  },
  {
    name: 'socrata-la-permits',
    routes: ['/api/socrata-la-permits'],
    load: () => import('../providers/wave10/specs/socrata-la-permits.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-la-permits', s.SPEC);
    }),
  },
  {
    name: 'socrata-seattle-911',
    routes: ['/api/socrata-seattle-911'],
    load: () => import('../providers/wave10/specs/socrata-seattle-911.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-seattle-911', s.SPEC);
    }),
  },
  {
    name: 'socrata-seattle-police911',
    routes: ['/api/socrata-seattle-police911'],
    load: () => import('../providers/wave10/specs/socrata-seattle-police911.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-seattle-police911', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-arkansas-flow',
    routes: ['/api/usgs-water-arkansas-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-arkansas-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-arkansas-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-chattahoochee-flow',
    routes: ['/api/usgs-water-chattahoochee-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-chattahoochee-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-chattahoochee-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-connecticut-flow',
    routes: ['/api/usgs-water-connecticut-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-connecticut-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-connecticut-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-dv-southeast',
    routes: ['/api/usgs-water-dv-southeast'],
    load: () => import('../providers/wave10/specs/usgs-water-dv-southeast.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-dv-southeast', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-gw-piedmont',
    routes: ['/api/usgs-water-gw-piedmont'],
    load: () => import('../providers/wave10/specs/usgs-water-gw-piedmont.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-gw-piedmont', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-james-flow',
    routes: ['/api/usgs-water-james-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-james-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-james-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-sacramento-flow',
    routes: ['/api/usgs-water-sacramento-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-sacramento-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-sacramento-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-savannah-flow',
    routes: ['/api/usgs-water-savannah-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-savannah-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-savannah-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-snake-flow',
    routes: ['/api/usgs-water-snake-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-snake-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-snake-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-stage-northeast',
    routes: ['/api/usgs-water-stage-northeast'],
    load: () => import('../providers/wave10/specs/usgs-water-stage-northeast.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-stage-northeast', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-temp-chattahoochee',
    routes: ['/api/usgs-water-temp-chattahoochee'],
    load: () => import('../providers/wave10/specs/usgs-water-temp-chattahoochee.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-temp-chattahoochee', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-temp-west',
    routes: ['/api/usgs-water-temp-west'],
    load: () => import('../providers/wave10/specs/usgs-water-temp-west.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-temp-west', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-tennessee-flow',
    routes: ['/api/usgs-water-tennessee-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-tennessee-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-tennessee-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-willamette-flow',
    routes: ['/api/usgs-water-willamette-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-willamette-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-willamette-flow', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-cd119-va',
    routes: ['/api/census-tiger-cd119-va'],
    load: () => import('../providers/wave10/specs/census-tiger-cd119-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-cd119-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-cdp-va',
    routes: ['/api/census-tiger-cdp-va'],
    load: () => import('../providers/wave10/specs/census-tiger-cdp-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-cdp-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-counties-ca',
    routes: ['/api/census-tiger-counties-ca'],
    load: () => import('../providers/wave10/specs/census-tiger-counties-ca.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-counties-ca', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-counties-va',
    routes: ['/api/census-tiger-counties-va'],
    load: () => import('../providers/wave10/specs/census-tiger-counties-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-counties-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-csa',
    routes: ['/api/census-tiger-csa'],
    load: () => import('../providers/wave10/specs/census-tiger-csa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-csa', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-divisions',
    routes: ['/api/census-tiger-divisions'],
    load: () => import('../providers/wave10/specs/census-tiger-divisions.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-divisions', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-places-va',
    routes: ['/api/census-tiger-places-va'],
    load: () => import('../providers/wave10/specs/census-tiger-places-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-places-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-puma-va',
    routes: ['/api/census-tiger-puma-va'],
    load: () => import('../providers/wave10/specs/census-tiger-puma-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-puma-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-regions',
    routes: ['/api/census-tiger-regions'],
    load: () => import('../providers/wave10/specs/census-tiger-regions.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-regions', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-sld-lower-va',
    routes: ['/api/census-tiger-sld-lower-va'],
    load: () => import('../providers/wave10/specs/census-tiger-sld-lower-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-sld-lower-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-sld-upper-va',
    routes: ['/api/census-tiger-sld-upper-va'],
    load: () => import('../providers/wave10/specs/census-tiger-sld-upper-va.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-sld-upper-va', s.SPEC);
    }),
  },
  {
    name: 'census-tiger-states',
    routes: ['/api/census-tiger-states'],
    load: () => import('../providers/wave10/specs/census-tiger-states.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('census-tiger-states', s.SPEC);
    }),
  },
  {
    name: 'socrata-honolulu-traffic',
    routes: ['/api/socrata-honolulu-traffic'],
    load: () => import('../providers/wave10/specs/socrata-honolulu-traffic.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-honolulu-traffic', s.SPEC);
    }),
  },
  {
    name: 'socrata-kcmo-311',
    routes: ['/api/socrata-kcmo-311'],
    load: () => import('../providers/wave10/specs/socrata-kcmo-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-kcmo-311', s.SPEC);
    }),
  },
  {
    name: 'socrata-kcmo-crime',
    routes: ['/api/socrata-kcmo-crime'],
    load: () => import('../providers/wave10/specs/socrata-kcmo-crime.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-kcmo-crime', s.SPEC);
    }),
  },
  {
    name: 'socrata-kcmo-permits',
    routes: ['/api/socrata-kcmo-permits'],
    load: () => import('../providers/wave10/specs/socrata-kcmo-permits.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-kcmo-permits', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-10-day',
    routes: ['/api/usgs-quakes-10-day'],
    load: () => import('../providers/wave10/specs/usgs-quakes-10-day.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-10-day', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-25-day',
    routes: ['/api/usgs-quakes-25-day'],
    load: () => import('../providers/wave10/specs/usgs-quakes-25-day.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-25-day', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-25-week',
    routes: ['/api/usgs-quakes-25-week'],
    load: () => import('../providers/wave10/specs/usgs-quakes-25-week.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-25-week', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-45-week',
    routes: ['/api/usgs-quakes-45-week'],
    load: () => import('../providers/wave10/specs/usgs-quakes-45-week.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-45-week', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-alaska',
    routes: ['/api/usgs-quakes-alaska'],
    load: () => import('../providers/wave10/specs/usgs-quakes-alaska.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-alaska', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-all-week',
    routes: ['/api/usgs-quakes-all-week'],
    load: () => import('../providers/wave10/specs/usgs-quakes-all-week.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-all-week', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-california',
    routes: ['/api/usgs-quakes-california'],
    load: () => import('../providers/wave10/specs/usgs-quakes-california.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-california', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-hawaii',
    routes: ['/api/usgs-quakes-hawaii'],
    load: () => import('../providers/wave10/specs/usgs-quakes-hawaii.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-hawaii', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-pacific-nw',
    routes: ['/api/usgs-quakes-pacific-nw'],
    load: () => import('../providers/wave10/specs/usgs-quakes-pacific-nw.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-pacific-nw', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-puerto-rico',
    routes: ['/api/usgs-quakes-puerto-rico'],
    load: () => import('../providers/wave10/specs/usgs-quakes-puerto-rico.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-puerto-rico', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-significant-month',
    routes: ['/api/usgs-quakes-significant-month'],
    load: () => import('../providers/wave10/specs/usgs-quakes-significant-month.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-significant-month', s.SPEC);
    }),
  },
  {
    name: 'usgs-quakes-significant-week',
    routes: ['/api/usgs-quakes-significant-week'],
    load: () => import('../providers/wave10/specs/usgs-quakes-significant-week.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-quakes-significant-week', s.SPEC);
    }),
  },
  {
    name: 'socrata-edmonton-311',
    routes: ['/api/socrata-edmonton-311'],
    load: () => import('../providers/wave10/specs/socrata-edmonton-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-edmonton-311', s.SPEC);
    }),
  },
  {
    name: 'socrata-edmonton-fire',
    routes: ['/api/socrata-edmonton-fire'],
    load: () => import('../providers/wave10/specs/socrata-edmonton-fire.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-edmonton-fire', s.SPEC);
    }),
  },
  {
    name: 'socrata-edmonton-permits',
    routes: ['/api/socrata-edmonton-permits'],
    load: () => import('../providers/wave10/specs/socrata-edmonton-permits.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-edmonton-permits', s.SPEC);
    }),
  },
  {
    name: 'socrata-edmonton-traffic',
    routes: ['/api/socrata-edmonton-traffic'],
    load: () => import('../providers/wave10/specs/socrata-edmonton-traffic.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-edmonton-traffic', s.SPEC);
    }),
  },
  {
    name: 'socrata-honolulu-311',
    routes: ['/api/socrata-honolulu-311'],
    load: () => import('../providers/wave10/specs/socrata-honolulu-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-honolulu-311', s.SPEC);
    }),
  },
  {
    name: 'socrata-honolulu-crime',
    routes: ['/api/socrata-honolulu-crime'],
    load: () => import('../providers/wave10/specs/socrata-honolulu-crime.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-honolulu-crime', s.SPEC);
    }),
  },
  {
    name: 'socrata-honolulu-permits',
    routes: ['/api/socrata-honolulu-permits'],
    load: () => import('../providers/wave10/specs/socrata-honolulu-permits.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-honolulu-permits', s.SPEC);
    }),
  },
  {
    name: 'socrata-oakland-311',
    routes: ['/api/socrata-oakland-311'],
    load: () => import('../providers/wave10/specs/socrata-oakland-311.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-oakland-311', s.SPEC);
    }),
  },
  {
    name: 'socrata-oakland-crime',
    routes: ['/api/socrata-oakland-crime'],
    load: () => import('../providers/wave10/specs/socrata-oakland-crime.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-oakland-crime', s.SPEC);
    }),
  },
  {
    name: 'socrata-sonoma-arrests',
    routes: ['/api/socrata-sonoma-arrests'],
    load: () => import('../providers/wave10/specs/socrata-sonoma-arrests.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-sonoma-arrests', s.SPEC);
    }),
  },
  {
    name: 'socrata-sonoma-events',
    routes: ['/api/socrata-sonoma-events'],
    load: () => import('../providers/wave10/specs/socrata-sonoma-events.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('socrata-sonoma-events', s.SPEC);
    }),
  },
  {
    name: 'cagov-algal-bloom-cases',
    routes: ['/api/cagov-algal-bloom-cases'],
    load: () => import('../providers/wave10/specs/cagov-algal-bloom-cases.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cagov-algal-bloom-cases', s.SPEC);
    }),
  },
  {
    name: 'cagov-algal-bloom-reports',
    routes: ['/api/cagov-algal-bloom-reports'],
    load: () => import('../providers/wave10/specs/cagov-algal-bloom-reports.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cagov-algal-bloom-reports', s.SPEC);
    }),
  },
  {
    name: 'cagov-beach-advisories',
    routes: ['/api/cagov-beach-advisories'],
    load: () => import('../providers/wave10/specs/cagov-beach-advisories.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cagov-beach-advisories', s.SPEC);
    }),
  },
  {
    name: 'cagov-beach-waterquality',
    routes: ['/api/cagov-beach-waterquality'],
    load: () => import('../providers/wave10/specs/cagov-beach-waterquality.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cagov-beach-waterquality', s.SPEC);
    }),
  },
  {
    name: 'cdec-reservoir-elevation',
    routes: ['/api/cdec-reservoir-elevation'],
    load: () => import('../providers/wave10/specs/cdec-reservoir-elevation.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cdec-reservoir-elevation', s.SPEC);
    }),
  },
  {
    name: 'cdec-reservoir-storage',
    routes: ['/api/cdec-reservoir-storage'],
    load: () => import('../providers/wave10/specs/cdec-reservoir-storage.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cdec-reservoir-storage', s.SPEC);
    }),
  },
  {
    name: 'cdec-snow-swe',
    routes: ['/api/cdec-snow-swe'],
    load: () => import('../providers/wave10/specs/cdec-snow-swe.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cdec-snow-swe', s.SPEC);
    }),
  },
  {
    name: 'cg-markets-top50',
    routes: ['/api/cg-markets-top50'],
    load: () => import('../providers/wave10/specs/cg-markets-top50.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cg-markets-top50', s.SPEC);
    }),
  },
  {
    name: 'cg-trending',
    routes: ['/api/cg-trending'],
    load: () => import('../providers/wave10/specs/cg-trending.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('cg-trending', s.SPEC);
    }),
  },
  {
    name: 'coops-currents-capecod',
    routes: ['/api/coops-currents-capecod'],
    load: () => import('../providers/wave10/specs/coops-currents-capecod.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-currents-capecod', s.SPEC);
    }),
  },
  {
    name: 'coops-currents-chesapeakebridge',
    routes: ['/api/coops-currents-chesapeakebridge'],
    load: () => import('../providers/wave10/specs/coops-currents-chesapeakebridge.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-currents-chesapeakebridge', s.SPEC);
    }),
  },
  {
    name: 'coops-currents-norfolk',
    routes: ['/api/coops-currents-norfolk'],
    load: () => import('../providers/wave10/specs/coops-currents-norfolk.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-currents-norfolk', s.SPEC);
    }),
  },
  {
    name: 'coops-salinity-baltimore',
    routes: ['/api/coops-salinity-baltimore'],
    load: () => import('../providers/wave10/specs/coops-salinity-baltimore.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-salinity-baltimore', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-dauphinisland',
    routes: ['/api/coops-waterlevel-dauphinisland'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-dauphinisland.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-dauphinisland', s.SPEC);
    }),
  },
  {
    name: 'coops-waterlevel-shellbeach',
    routes: ['/api/coops-waterlevel-shellbeach'],
    load: () => import('../providers/wave10/specs/coops-waterlevel-shellbeach.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-waterlevel-shellbeach', s.SPEC);
    }),
  },
  {
    name: 'coops-watertemp-baltimore',
    routes: ['/api/coops-watertemp-baltimore'],
    load: () => import('../providers/wave10/specs/coops-watertemp-baltimore.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-watertemp-baltimore', s.SPEC);
    }),
  },
  {
    name: 'coops-watertemp-providence',
    routes: ['/api/coops-watertemp-providence'],
    load: () => import('../providers/wave10/specs/coops-watertemp-providence.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('coops-watertemp-providence', s.SPEC);
    }),
  },
  {
    name: 'mb-artist-search-queen',
    routes: ['/api/mb-artist-search-queen'],
    load: () => import('../providers/wave10/specs/mb-artist-search-queen.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('mb-artist-search-queen', s.SPEC);
    }),
  },
  {
    name: 'ol-search-solar',
    routes: ['/api/ol-search-solar'],
    load: () => import('../providers/wave10/specs/ol-search-solar.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('ol-search-solar', s.SPEC);
    }),
  },
  {
    name: 'ol-subject-science',
    routes: ['/api/ol-subject-science'],
    load: () => import('../providers/wave10/specs/ol-subject-science.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('ol-subject-science', s.SPEC);
    }),
  },
  {
    name: 'ol-trending-daily',
    routes: ['/api/ol-trending-daily'],
    load: () => import('../providers/wave10/specs/ol-trending-daily.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('ol-trending-daily', s.SPEC);
    }),
  },
  {
    name: 'ol-trending-weekly',
    routes: ['/api/ol-trending-weekly'],
    load: () => import('../providers/wave10/specs/ol-trending-weekly.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('ol-trending-weekly', s.SPEC);
    }),
  },
  {
    name: 'om-aq-current-europe',
    routes: ['/api/om-aq-current-europe'],
    load: () => import('../providers/wave10/specs/om-aq-current-europe.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-aq-current-europe', s.SPEC);
    }),
  },
  {
    name: 'om-aq-current-us',
    routes: ['/api/om-aq-current-us'],
    load: () => import('../providers/wave10/specs/om-aq-current-us.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-aq-current-us', s.SPEC);
    }),
  },
  {
    name: 'om-elevation-extremes',
    routes: ['/api/om-elevation-extremes'],
    load: () => import('../providers/wave10/specs/om-elevation-extremes.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-elevation-extremes', s.SPEC);
    }),
  },
  {
    name: 'om-elevation-uscities',
    routes: ['/api/om-elevation-uscities'],
    load: () => import('../providers/wave10/specs/om-elevation-uscities.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-elevation-uscities', s.SPEC);
    }),
  },
  {
    name: 'om-ensemble-gfs-us',
    routes: ['/api/om-ensemble-gfs-us'],
    load: () => import('../providers/wave10/specs/om-ensemble-gfs-us.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-ensemble-gfs-us', s.SPEC);
    }),
  },
  {
    name: 'om-ensemble-icon-europe',
    routes: ['/api/om-ensemble-icon-europe'],
    load: () => import('../providers/wave10/specs/om-ensemble-icon-europe.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-ensemble-icon-europe', s.SPEC);
    }),
  },
  {
    name: 'om-era5-aug2026-cities',
    routes: ['/api/om-era5-aug2026-cities'],
    load: () => import('../providers/wave10/specs/om-era5-aug2026-cities.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-era5-aug2026-cities', s.SPEC);
    }),
  },
  {
    name: 'om-flood-discharge-rivers',
    routes: ['/api/om-flood-discharge-rivers'],
    load: () => import('../providers/wave10/specs/om-flood-discharge-rivers.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-flood-discharge-rivers', s.SPEC);
    }),
  },
  {
    name: 'om-geocode-cambridge',
    routes: ['/api/om-geocode-cambridge'],
    load: () => import('../providers/wave10/specs/om-geocode-cambridge.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-geocode-cambridge', s.SPEC);
    }),
  },
  {
    name: 'om-geocode-portland',
    routes: ['/api/om-geocode-portland'],
    load: () => import('../providers/wave10/specs/om-geocode-portland.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-geocode-portland', s.SPEC);
    }),
  },
  {
    name: 'om-marine-current-us',
    routes: ['/api/om-marine-current-us'],
    load: () => import('../providers/wave10/specs/om-marine-current-us.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-marine-current-us', s.SPEC);
    }),
  },
  {
    name: 'om-marine-current-world',
    routes: ['/api/om-marine-current-world'],
    load: () => import('../providers/wave10/specs/om-marine-current-world.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('om-marine-current-world', s.SPEC);
    }),
  },
  {
    name: 'usgs-volcano-elevated',
    routes: ['/api/usgs-volcano-elevated'],
    load: () => import('../providers/wave10/specs/usgs-volcano-elevated.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-volcano-elevated', s.SPEC);
    }),
  },
  {
    name: 'usgs-volcano-status-all',
    routes: ['/api/usgs-volcano-status-all'],
    load: () => import('../providers/wave10/specs/usgs-volcano-status-all.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-volcano-status-all', s.SPEC);
    }),
  },
  {
    name: 'usgs-volcano-status-geojson',
    routes: ['/api/usgs-volcano-status-geojson'],
    load: () => import('../providers/wave10/specs/usgs-volcano-status-geojson.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-volcano-status-geojson', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-brazos-flow',
    routes: ['/api/usgs-water-brazos-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-brazos-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-brazos-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-capefear-flow',
    routes: ['/api/usgs-water-capefear-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-capefear-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-capefear-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-cumberland-flow',
    routes: ['/api/usgs-water-cumberland-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-cumberland-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-cumberland-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-deschutes-flow',
    routes: ['/api/usgs-water-deschutes-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-deschutes-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-deschutes-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-gila-flow',
    routes: ['/api/usgs-water-gila-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-gila-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-gila-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-gw-ogallala',
    routes: ['/api/usgs-water-gw-ogallala'],
    load: () => import('../providers/wave10/specs/usgs-water-gw-ogallala.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-gw-ogallala', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-klamath-flow',
    routes: ['/api/usgs-water-klamath-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-klamath-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-klamath-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-merrimack-flow',
    routes: ['/api/usgs-water-merrimack-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-merrimack-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-merrimack-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-platte-flow',
    routes: ['/api/usgs-water-platte-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-platte-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-platte-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-quality-do-midatlantic',
    routes: ['/api/usgs-water-quality-do-midatlantic'],
    load: () => import('../providers/wave10/specs/usgs-water-quality-do-midatlantic.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-quality-do-midatlantic', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-quality-ph-west',
    routes: ['/api/usgs-water-quality-ph-west'],
    load: () => import('../providers/wave10/specs/usgs-water-quality-ph-west.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-quality-ph-west', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-quality-turbidity',
    routes: ['/api/usgs-water-quality-turbidity'],
    load: () => import('../providers/wave10/specs/usgs-water-quality-turbidity.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-quality-turbidity', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-redriver-flow',
    routes: ['/api/usgs-water-redriver-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-redriver-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-redriver-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-rogue-flow',
    routes: ['/api/usgs-water-rogue-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-rogue-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-rogue-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-sanjoaquin-flow',
    routes: ['/api/usgs-water-sanjoaquin-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-sanjoaquin-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-sanjoaquin-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-skagit-flow',
    routes: ['/api/usgs-water-skagit-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-skagit-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-skagit-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-stage-redriver-fargo',
    routes: ['/api/usgs-water-stage-redriver-fargo'],
    load: () => import('../providers/wave10/specs/usgs-water-stage-redriver-fargo.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-stage-redriver-fargo', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-trinity-tx-flow',
    routes: ['/api/usgs-water-trinity-tx-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-trinity-tx-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-trinity-tx-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-truckee-flow',
    routes: ['/api/usgs-water-truckee-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-truckee-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-truckee-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-wabash-flow',
    routes: ['/api/usgs-water-wabash-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-wabash-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-wabash-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-wisconsin-flow',
    routes: ['/api/usgs-water-wisconsin-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-wisconsin-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-wisconsin-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-yellowstone-flow',
    routes: ['/api/usgs-water-yellowstone-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-yellowstone-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-yellowstone-flow', s.SPEC);
    }),
  },
  {
    name: 'usgs-water-yukon-flow',
    routes: ['/api/usgs-water-yukon-flow'],
    load: () => import('../providers/wave10/specs/usgs-water-yukon-flow.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('usgs-water-yukon-flow', s.SPEC);
    }),
  },
  {
    name: 'wb-gdp-usa',
    routes: ['/api/wb-gdp-usa'],
    load: () => import('../providers/wave10/specs/wb-gdp-usa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-gdp-usa', s.SPEC);
    }),
  },
  {
    name: 'wb-indicator-catalog',
    routes: ['/api/wb-indicator-catalog'],
    load: () => import('../providers/wave10/specs/wb-indicator-catalog.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-indicator-catalog', s.SPEC);
    }),
  },
  {
    name: 'wb-life-expectancy-usa',
    routes: ['/api/wb-life-expectancy-usa'],
    load: () => import('../providers/wave10/specs/wb-life-expectancy-usa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-life-expectancy-usa', s.SPEC);
    }),
  },
  {
    name: 'wb-population-usa',
    routes: ['/api/wb-population-usa'],
    load: () => import('../providers/wave10/specs/wb-population-usa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-population-usa', s.SPEC);
    }),
  },
  {
    name: 'wb-population-world',
    routes: ['/api/wb-population-world'],
    load: () => import('../providers/wave10/specs/wb-population-world.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-population-world', s.SPEC);
    }),
  },
  {
    name: 'wb-unemployment-usa',
    routes: ['/api/wb-unemployment-usa'],
    load: () => import('../providers/wave10/specs/wb-unemployment-usa.mjs').then(async (s) => {
      const g = await import('../providers/wave10/generic.js');
      return g.specProxy('wb-unemployment-usa', s.SPEC);
    }),
  },
  {
    name: 'king-tides',
    routes: ['/api/king-tides'],
    load: () => import('../providers/wave6/tides.js').then((m) => m.kingTidesProxy()),
  },
];

export { REGISTRY };

/** Route prefixes intentionally excluded from the Pages stack (see header). */
export const EXCLUDED = [
  { name: 'ais-live', routes: ['/api/ais-live'], why: 'keyed upstream WebSocket; no key in keyless deploy' },
  { name: 'local-receivers', routes: ['/api/receivers'], why: 'LAN-local receivers unreachable from the edge' },
  { name: 'key-setup', routes: ['/api/setup/keys', '/api/setup/status'], why: 'writes local .env; no writable fs on Pages' },
];
