import { createSpaceWeatherLayer } from '../../layers/spaceWeather/index.js';
/** Wire the NOAA SWPC ACE solar-wind feed to the application. */
export function createApplicationSpaceWeather(options) {
  return createSpaceWeatherLayer({ ...options });
}
