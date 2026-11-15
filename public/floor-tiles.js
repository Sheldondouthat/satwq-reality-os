/* God's Eye — floor tiles logic (Ghost Tiles consumption): the home-
 * region PMTiles floor package, as pure functions. No DOM, no fetch —
 * every function takes its inputs explicitly so the module is testable
 * end to end. (The SHA-256 helper is the one async member: WebCrypto.)
 *
 * The constitution this implements (Packaging Matrix row 3 + V5-0):
 *  1. The floor is a RECORD, not a feed. It was built once, at the
 *     manifest's floor_built_at_utc, from a named source package; its
 *     age is rendered from that build timestamp — never from fetch
 *     time, and it can NEVER classify as 'live'. The strongest grammar
 *     the floor can wear is 'floor' (a verified offline record).
 *  2. The archive is served only after hash verification: the bytes'
 *     SHA-256 and length must match the Ghost Tiles manifest exactly.
 *     A mismatch is a REFUSAL — the archive is not cached, not served,
 *     and the refusal is recorded (see sw.js, the Ghost Tiles client).
 *  3. Tiles are read client-side by HTTP Range requests against the
 *     one verified archive (the PMTiles protocol). No tile server
 *     exists anywhere in the path.
 *  4. Honesty rides in the tiles: every building carries height_class
 *     (Modeled vs ESTIMATED), height_source, and its ESTIMATED reason.
 *     The face colors buildings BY height_class so the classes can
 *     never blur on screen.
 */

export const FLOOR_TILES_PACKAGE = Object.freeze({
  id: 'gev-floor-tiles-home-region',
  version: 1,
});

export const FLOOR_MANIFEST_URL = '/floor/floor-manifest.json';
export const FLOOR_ARCHIVE_URL = '/floor/home-region.pmtiles';
export const FLOOR_ARCHIVE_NAME = 'home-region.pmtiles';
/** Virtual URL answered by the service worker (never a real file). */
export const FLOOR_STATUS_URL = '/floor/floor-status.json';

function parseTimeMs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Validate a Ghost Tiles floor manifest. Returns the normalized
 * manifest the face and the verifier consume, or null when the
 * manifest cannot honestly describe a floor (no parseable build
 * timestamp, or the archive entry lacks a well-formed SHA-256 /
 * positive byte count). A null manifest renders age UNKNOWN —
 * the floor never invents a birthday.
 */
export function parseManifest(json) {
  if (!json || typeof json !== 'object') return null;
  const builtAtMs = parseTimeMs(json.floor_built_at_utc);
  if (builtAtMs == null) return null;
  const entry = json.files?.[FLOOR_ARCHIVE_NAME];
  if (!entry || !isSha256Hex(entry.sha256)) return null;
  if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) return null;
  return {
    packageId:
      typeof json.package === 'string' ? json.package : FLOOR_TILES_PACKAGE.id,
    region: typeof json.region === 'string' ? json.region : null,
    builtAt: new Date(builtAtMs).toISOString(),
    builtAtMs,
    sourceBuiltAt:
      typeof json.source_built_at_utc === 'string'
        ? json.source_built_at_utc
        : null,
    sourcePackage:
      typeof json.source_package === 'string' ? json.source_package : null,
    archive: {
      name: FLOOR_ARCHIVE_NAME,
      sha256: entry.sha256,
      bytes: entry.bytes,
    },
    layers: Array.isArray(json.layers)
      ? json.layers.filter((l) => typeof l === 'string')
      : [],
    sourceCounts:
      json.source_counts && typeof json.source_counts === 'object'
        ? json.source_counts
        : null,
  };
}

/** Age of the floor at nowMs, from the manifest's BUILD timestamp. */
export function floorAgeSecondsAt(manifest, nowMs) {
  if (!manifest || !Number.isFinite(manifest.builtAtMs)) return null;
  if (!Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - manifest.builtAtMs) / 1000));
}

/**
 * The one classification the floor face renders through.
 *   state: 'floor'   — a manifest describes this record; age printed.
 *          'unknown' — no valid manifest; the floor's age is UNKNOWN.
 * 'live' is not in this vocabulary and can never be returned: the
 * floor is a built record, however fresh the build.
 */
export function classifyFloor(manifest, nowMs) {
  const ageSeconds = floorAgeSecondsAt(manifest, nowMs);
  if (!manifest || ageSeconds == null) {
    return { state: 'unknown', ageSeconds: null, builtAt: null };
  }
  return { state: 'floor', ageSeconds, builtAt: manifest.builtAt };
}

/** SHA-256 of bytes (ArrayBuffer or Uint8Array) as lowercase hex. */
export async function sha256Hex(data) {
  const buffer =
    data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
      : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify archive bytes against a parsed manifest: SHA-256 AND byte
 * length must both match. This is the check the Ghost Tiles client
 * (sw.js) performs before the archive may be cached or served; a
 * false result is a refusal, never a warning.
 */
export async function verifyArchive(manifest, data) {
  if (!manifest) return { ok: false, reason: 'no-manifest', actual: null };
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const actual = await sha256Hex(bytes);
  const expected = manifest.archive.sha256;
  if (bytes.byteLength !== manifest.archive.bytes) {
    return {
      ok: false,
      reason: 'byte-count-mismatch',
      expected,
      actual,
      expectedBytes: manifest.archive.bytes,
      actualBytes: bytes.byteLength,
    };
  }
  if (actual !== expected) {
    return { ok: false, reason: 'sha256-mismatch', expected, actual };
  }
  return { ok: true, expected, actual };
}

/**
 * Parse an HTTP Range header against a total byte length.
 * Returns { start, end } (inclusive) for a single satisfiable range,
 * or null when the header is absent/invalid/multi-range — the caller
 * then serves the full body (the PMTiles client only ever sends
 * single ranges).
 */
export function parseRangeHeader(header, totalBytes) {
  if (typeof header !== 'string' || !Number.isInteger(totalBytes) || totalBytes <= 0) {
    return null;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  let start;
  let end;
  if (first === '') {
    // Suffix range: the last N bytes.
    const suffix = Number(last);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(first);
    if (!Number.isFinite(start) || start >= totalBytes) return null;
    end = last === '' ? totalBytes - 1 : Math.min(Number(last), totalBytes - 1);
    if (!Number.isFinite(end) || end < start) return null;
  }
  return { start, end };
}

/** Human age: 45 → "45 s", 750 → "12 min", 79200 → "22 h 00 min". */
export function formatFloorAge(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return 'UNKNOWN';
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const hm = `${hours} h ${String(mins).padStart(2, '0')} min`;
  return days > 0 ? `${days} d ${hm}` : hm;
}
