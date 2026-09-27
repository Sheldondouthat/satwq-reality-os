import { normalizeTidePredictions } from './records.js';

/**
 * Curated NOAA CO-OPS tide stations (verified live 2026-09-26). Locations are
 * static — only the predictions are fetched.
 */
export const TIDE_STATIONS = Object.freeze([
  { id: '8454000', name: 'Providence, RI', lat: 41.807167, lon: -71.400665 },
  { id: '8531680', name: 'Sandy Hook, NJ', lat: 40.4669, lon: -74.0094 },
  { id: '8574680', name: 'Baltimore, MD', lat: 39.266693, lon: -76.57831 },
  { id: '8661070', name: 'Springmaid Pier, SC', lat: 33.655, lon: -78.9183 },
  { id: '8723214', name: 'Virginia Key, FL', lat: 25.7314, lon: -80.1618 },
  { id: '8771450', name: 'Galveston, TX', lat: 29.31, lon: -94.7933 },
  { id: '9414290', name: 'San Francisco, CA', lat: 37.806305, lon: -122.46589 },
  { id: '9447130', name: 'Seattle, WA', lat: 47.60264, lon: -122.3393 },
  { id: '1612340', name: 'Honolulu, HI', lat: 21.303333, lon: -157.86453 },
]);

const yyyymmdd = (date) =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;

/** Fetch high/low tide predictions for the curated stations. Stations that fail are skipped, never fatal. */
export function createTideSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  stations = TIDE_STATIONS,
  now = () => Date.now(),
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const start = new Date(now());
      const end = new Date(now() + 24 * 3600_000);
      const rows = [];
      for (const station of stations) {
        signal?.throwIfAborted();
        const url =
          'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter' +
          `?product=predictions&begin_date=${yyyymmdd(start)}&end_date=${yyyymmdd(end)}` +
          `&datum=MLLW&station=${encodeURIComponent(station.id)}` +
          '&time_zone=gmt&units=english&interval=hilo&format=json&application=gev';
        try {
          const response = await fetchImpl(url, { signal });
          if (!response.ok) continue;
          const payload = await response.json();
          const events = normalizeTidePredictions(payload);
          if (!events || events.length === 0) continue;
          rows.push({
            stableId: station.id,
            stationId: station.id,
            name: station.name,
            lon: station.lon,
            lat: station.lat,
            events,
          });
        } catch {
          // One bad station never sinks the layer.
          continue;
        }
      }
      return rows;
    },
  };
}
