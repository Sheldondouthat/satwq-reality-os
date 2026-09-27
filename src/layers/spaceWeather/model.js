import * as Cesium from 'cesium';

const SLOW = Cesium.Color.LIMEGREEN;
const FAST = Cesium.Color.RED;

/**
 * Point color for a solar-wind speed: green near 300 km/s, ramping to red
 * at 800+ km/s.
 */
export function solarWindColor(speedKms) {
  const t = Math.min(1, Math.max(0, (speedKms - 300) / 500));
  return Cesium.Color.lerp(SLOW, FAST, t, new Cesium.Color());
}

/** Label text for a normalized solar-wind row. */
export function solarWindLabel({ speedKms, bzGsm }) {
  return `SOLAR WIND ${Math.round(speedKms)} km/s · Bz ${bzGsm.toFixed(1)} nT`;
}

/** Short human summary for stats/analyst views. */
export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `space-weather-${index}`,
    type: 'space-weather',
    speedKms: raw.speedKms ?? null,
    densityPerCm3: raw.densityPerCm3 ?? null,
    tempK: raw.tempK ?? null,
    bzGsm: raw.bzGsm ?? null,
    timeMs: raw.timeMs ?? null,
  };
}
