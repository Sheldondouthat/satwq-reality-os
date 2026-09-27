/**
 * NOT-CONFIGURED sentinel handling (SnapDeploy free-tier deploy).
 *
 * SnapDeploy's deploy wizard refuses to submit unless every declared env var
 * has a non-empty value, so keyless deploys enter the sentinel value
 * `NOT-CONFIGURED` for keys the operator does not have. Every key consumer in
 * this codebase already trims values before use, so treating the sentinel
 * exactly like an absent key reproduces the verified keyless behavior.
 *
 * Two integration points:
 *  - server: `scrubKeySentinels()` deletes sentinel/empty values from
 *    process.env at startup, before any provider reads them.
 *  - build: `cleanKey()` sanitizes values injected into the client bundle
 *    via `define` (the Docker image runs `vite build` at build time, so
 *    build-time env must be sanitized too).
 */

export const KEY_SENTINEL = 'NOT-CONFIGURED';

/** Provider key env vars the sentinel may stand in for. */
export const SENTINEL_KEY_NAMES = Object.freeze([
  'AISSTREAM_API_KEY',
  'CESIUM_ION_TOKEN',
  'FIRMS_MAP_KEY',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_MAPS_SERVER_API_KEY',
  'LL2_API_TOKEN',
  'OPENAI_API_KEY',
  'OPENSKY_CLIENT_ID',
  'OPENSKY_CLIENT_SECRET',
]);

/** True when a raw env value is empty/blank or the NOT-CONFIGURED sentinel. */
export function isKeySentinel(value) {
  const text = String(value ?? '').trim();
  return text === '' || text === KEY_SENTINEL;
}

/**
 * Bundle-safe key value: '' when the input is empty/blank or the sentinel,
 * otherwise the original value untouched.
 */
export function cleanKey(value) {
  return isKeySentinel(value) ? '' : value;
}

/**
 * Delete sentinel/empty provider keys from the given env mapping (defaults
 * to process.env). Returns the scrubbed names. Idempotent.
 */
export function scrubKeySentinels(env = process.env) {
  const scrubbed = [];
  for (const name of SENTINEL_KEY_NAMES) {
    if (Object.hasOwn(env, name) && isKeySentinel(env[name])) {
      delete env[name];
      scrubbed.push(name);
    }
  }
  return scrubbed;
}
