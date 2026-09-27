import {
  createOpenSkySource,
  createAdsbLolSource,
  createAisStreamSource,
} from '../sources/live/standalone.js';
import { createCctvSource } from '../layers/cctv/source.js';
import { createRadioSource } from '../layers/radio/source.js';
import { createTransitSource } from '../layers/transit/source.js';
import { createTrafficSource } from '../layers/traffic/source.js';
import { createBikeshareSource } from '../layers/bikeshare/source.js';
import { createInstallationSource } from '../layers/installations/source.js';
import { createSatelliteSource } from '../layers/satellites/source.js';
import { createLaunchSource } from '../layers/launches/source.js';
import { createOverpassAlprSource } from '../layers/alpr/source.js';
import { createWeatherSource } from '../layers/weather/source.js';
import { createCycloneSource } from '../layers/cyclones/source.js';
import { createWindSource } from '../layers/wind/source.js';
import { createFirmsSource } from '../layers/firms/source.js';
import { createVolcanoSource } from '../layers/volcanoes/source.js';
import { createTideSource } from '../layers/tides/source.js';
import { createAuroraSource } from '../layers/aurora/source.js';
import { createBuoySource } from '../layers/buoys/source.js';
import { createMeteorSource } from '../layers/meteors/source.js';
import { createHmsSmokeSource } from '../layers/hmsSmoke/source.js';
import { createSpaceWeatherSource } from '../layers/spaceWeather/source.js';
import { createTerminatorSource } from '../layers/terminator/source.js';
import { createGibsTruecolorSource } from '../layers/gibsTruecolor/index.js';
import { createGibsNightlightsSource } from '../layers/gibsNightlights/index.js';
import { createGibsChlorophyllSource } from '../layers/gibsChlorophyll/index.js';
import { createGibsSstSource } from '../layers/gibsSst/index.js';
import { createRainviewerRadarSource } from '../layers/rainviewerRadar/index.js';
import { createRainviewerSatelliteSource } from '../layers/rainviewerSatellite/index.js';
import { createReferenceSources } from '../sources/reference.js';
export { createReferenceSources as createStandaloneReferenceSources } from '../sources/reference.js';

/** Select standalone providers without starting their acquisition. */
export function createStandaloneLayerSources() {
  return {
    ...createReferenceSources(),
    flights: createOpenSkySource(),
    military: createAdsbLolSource(),
    vessels: createAisStreamSource({
      apiUrl: import.meta.env?.VITE_AIS_LIVE_API_URL || '/api/ais-live',
    }),
    cctv: createCctvSource(),
    radio: createRadioSource(),
    traffic: createTrafficSource(),
    transit: createTransitSource(),
    bikeshare: createBikeshareSource(),
    installations: createInstallationSource(),
    satellites: createSatelliteSource(),
    launches: createLaunchSource(),
    alpr: createOverpassAlprSource(),
    firms: createFirmsSource(),
    wind: createWindSource(),
    weather: createWeatherSource(),
    cyclones: createCycloneSource(),
    volcanoes: createVolcanoSource(),
    tides: createTideSource(),
    aurora: createAuroraSource(),
    buoys: createBuoySource(),
    meteors: createMeteorSource(),
    'hms-smoke': createHmsSmokeSource(),
    'space-weather': createSpaceWeatherSource(),
    terminator: createTerminatorSource(),
    gibsTruecolor: createGibsTruecolorSource(),
    gibsNightlights: createGibsNightlightsSource(),
    gibsChlorophyll: createGibsChlorophyllSource(),
    gibsSst: createGibsSstSource(),
    rainviewerRadar: createRainviewerRadarSource(),
    rainviewerSatellite: createRainviewerSatelliteSource(),
  };
}
