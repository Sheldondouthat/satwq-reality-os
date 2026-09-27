import { openSkyProxy } from './aircraft/opensky.js';
import { celestrakProxy, rocketLaunchesProxy } from './space.js';
import { tomtomProxy } from './traffic.js';
import { firmsProxy } from './firms.js';
import { terrainHeightsProxy } from './terrain.js';
import { adsbdbProxy } from './aircraft/enrichment.js';
import { overpassProxy } from './overpass.js';
import { militaryInstallationsProxy } from './military-installations.js';
import { regionalBriefProxy } from './regional/briefing.js';
import { geocodeProxy } from './regional/place.js';
import { weatherEffectsProxy } from './regional/weather-effects.js';
import { cctvProxy } from './cctv.js';
import { defaultSourceRoot } from './common/source-root.js';
import { radioBrowserProxy } from './radio.js';
import { gbfsProxy } from './gbfs.js';
import { localReceiversProxy } from './local-receivers.js';
import { transitProxy } from './transit.js';
import { adsbLolProxy } from './aircraft/adsb-lol.js';
import { aisLiveProxy } from './vessels/ais-live.js';
import { trackBackfillProxies } from './aircraft/tracks.js';
import { hmsSmokeProxy } from './hmsSmoke.js';
import { openAiRealtimeProxy } from './openai.js';
import { googlePlacesContextProxy } from './places.js';
import { keySetupEndpoint } from '../standalone/key-setup.js';
import { weatherProxy } from './weather.js';
import { firePerimetersProxy } from './firePerimeters.js';
import { cycloneProxy } from './cyclones.js';
import { windProxy } from './wind.js';
import { eventSynthesisProxy } from './eventSynthesis.js';
import { invisibleOceanProxy } from './invisibleOceanProxy.js';
import { vaacProxy } from './vaac.js';
import { interplanetaryProxy } from './wave3/interplanetary.js';
import { neoProxy } from './wave3/neo.js';
import { gracedbProxy } from './wave3/gracedb.js';
import { nwisGaugesProxy } from './wave3/nwisGauges.js';
import { nwpsProxy } from './wave3/nwps.js';
import { sensorCommunityProxy } from './wave3/sensorCommunity.js';
import { swpcProxy } from './wave3/swpc.js';
import { donkiProxy } from './wave3/donki.js';
import { nwsAlertsProxy } from './wave3/nwsAlerts.js';
import { sigmetsProxy } from './wave3/sigmets.js';
import { radiationProxy } from './wave3/radiation.js';
import { dartCouplingProxy } from './wave3/dart.js';
import { wxstationsProxy } from './wave5/wxstations.js';
import { timeProxy } from './wave5/time.js';
import { quakesProxy } from './wave5/quakes.js';
import { feltProxy } from './wave5/felt.js';
import { hazardsProxy } from './wave5/hazards.js';
import { volcanoProxy } from './wave5/volcano.js';
import { asteroidsProxy } from './wave5/asteroids.js';
import { potaProxy } from './wave5/pota.js';
import { radioReferenceProxy } from './wave5/radioReference.js';
import { satnogsProxy } from './wave5/satnogs.js';
import { co2Proxy } from './wave5/co2.js';
import { uvProxy } from './wave5/uv.js';
import { marketsProxy } from './wave5/markets.js';
import { carbonProxy } from './wave5/carbon.js';
import { certsProxy } from './wave5/certs.js';
import { civicProxy } from './wave5/civic.js';
import { researchProxy } from './wave5/research.js';
import { biosphereProxy } from './wave5/biosphere.js';
import { waterTwinProxy } from './wave3/waterTwin.js';
import { ripestatProxy } from './wave3/ripestat.js';
import { feodoProxy } from './wave3/feodo.js';
import { gdeltProxy } from './wave3/gdelt.js';
import { gmnProxy } from './wave3/gmn.js';
import { eibiProxy } from './wave3/eibi.js';
import { aishubProxy } from './wave3/aishub.js';
import { fireballsProxy } from './wave3/fireballs.js';
import { socratesProxy } from './wave3/socrates.js';
import { nmdbProxy } from './wave3/nmdb.js';
import { argoProxy } from './wave3/argo.js';
import { reentriesProxy } from './wave3/reentries.js';

/** Construct the local provider plugins in their established order. */
function localProviderPlugins() {
  return [
    openSkyProxy(),
    celestrakProxy(),
    tomtomProxy(),
    firmsProxy(),
    rocketLaunchesProxy(),
    terrainHeightsProxy(),
    adsbdbProxy(),
    overpassProxy(),
    militaryInstallationsProxy(),
    regionalBriefProxy(),
    geocodeProxy(),
    weatherEffectsProxy(),
    cctvProxy({ sourceRoot: defaultSourceRoot }),
    radioBrowserProxy(),
    gbfsProxy(),
    localReceiversProxy(),
    transitProxy(),
    adsbLolProxy(),
    aisLiveProxy(),
    trackBackfillProxies(),
    openAiRealtimeProxy(),
    googlePlacesContextProxy(),
    windProxy(),
    weatherProxy(),
    cycloneProxy(),
    firePerimetersProxy(),
    hmsSmokeProxy(),
    eventSynthesisProxy(),
    invisibleOceanProxy(),
    vaacProxy(),
    interplanetaryProxy(),
    neoProxy(),
    gracedbProxy(),
    nwisGaugesProxy(),
    nwpsProxy(),
    sensorCommunityProxy(),
    swpcProxy(),
    donkiProxy(),
    nwsAlertsProxy(),
    sigmetsProxy(),
    radiationProxy(),
    dartCouplingProxy(),
    waterTwinProxy(),
    ripestatProxy(),
    feodoProxy(),
    gdeltProxy(),
    gmnProxy(),
    eibiProxy(),
    aishubProxy(),
    fireballsProxy(),
    socratesProxy(),
    nmdbProxy(),
    argoProxy(),
    reentriesProxy(),
    wxstationsProxy(),
    timeProxy(),
    quakesProxy(),
    feltProxy(),
    hazardsProxy(),
    volcanoProxy(),
    asteroidsProxy(),
    potaProxy(),
    radioReferenceProxy(),
    satnogsProxy(),
    co2Proxy(),
    uvProxy(),
    marketsProxy(),
    carbonProxy(),
    certsProxy(),
    civicProxy(),
    researchProxy(),
    biosphereProxy(),
    keySetupEndpoint(),
  ];
}

export { localProviderPlugins };

export {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  fetchCctvImageFromUpstream,
} from './cctv.js';
export {
  createRadioProxyMiddleware,
  isPublicRadioAddress,
  normalizeRadioBrowserStation,
  publicRadioStation,
  publicRadioHttpsUrl,
} from './radio.js';
export { LL2_CACHE_TTL_MS, launchLibraryRequestHeaders } from './space.js';
export { googlePlacesContextProxy } from './places.js';
export { googleServerApiKey } from './places.js';
export { keylessGooglePlacesResponse } from './places.js';
export { adsbLolFallbackAnchor } from './aircraft/opensky.js';
export { readResponseTextCapped } from './common/http.js';
export { readResponseJsonCapped } from './common/http.js';
export { coalesceProxyRequest } from './common/http.js';
export { requiredFiniteQueryNumber } from './common/query.js';
export { isOverpassBoundaryQuery } from './overpass/query.js';
export { simplifyOverpassPayloadBody } from './overpass/geometry.js';
export { readOverpassDisk } from './overpass/cache.js';
export { resolveOverpassPreflight } from './overpass/cache.js';
export { overpassPayloadIsData } from './overpass/transport.js';
export { fetchOverpassPayload } from './overpass/transport.js';
export { openAiRealtimeProxy } from './openai.js';
export { MILITARY_INSTALLATION_ELEMENT_CAP } from './military-installations/constants.js';
export { quantizeMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationCacheKey } from './military-installations/query.js';
export { resolveMilitaryInstallationTier } from './military-installations/cache.js';
export { migrateMilitaryInstallationEntry } from './military-installations/cache.js';
export { militaryInstallationDiskFresh } from './military-installations/cache.js';
export { militaryInstallationDiskPath } from './military-installations/cache.js';
export { readMilitaryInstallationDisk } from './military-installations/cache.js';
export { writeMilitaryInstallationDisk } from './military-installations/cache.js';
export { validMilitaryInstallationBox } from './military-installations/query.js';
export { militaryInstallationFailureReason } from './military-installations/query.js';
export { validRegionalPoint } from './regional/query.js';
export { regionalBriefHasAnySource } from './regional/briefing.js';
