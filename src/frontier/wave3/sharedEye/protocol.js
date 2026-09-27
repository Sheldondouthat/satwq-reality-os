/**
 * Shared God's eye — P2P session protocol (pure, fully testable).
 *
 * No server: two+ viewers share one session over WebRTC data channels.
 * Signaling is manual copy-paste of room codes (base64url JSON) — no
 * signaling server, no accounts, no TURN (see net.js for the honest NAT
 * limitation). If P2P fails, follow-mode (copy-paste camera state) is the
 * fallback, implemented in follow.js.
 *
 * Message envelope on the `satwq-eye` data channel:
 *   { t: 'hello',  name }                                  — join handshake
 *   { t: 'camera', lon, lat, height, heading, pitch }       — camera state
 *   { t: 'cursor', lon, lat }                               — shared cursor
 *   { t: 'note',   id, lon, lat, text, by }                 — pinned note
 *   { t: 'bye',    name }                                   — clean leave
 */

export const CHANNEL_LABEL = 'satwq-eye';
export const PROTOCOL_VERSION = 1;

function utf8ToB64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToUtf8(code) {
  const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode a signaling payload (offer/answer) as a copy-paste room code. */
export function encodeRoomCode(payload) {
  return utf8ToB64Url(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
}

/** Decode a room code back to its payload. Returns null on any failure. */
export function decodeRoomCode(code) {
  if (typeof code !== 'string' || !code.length || code.length > 20000) return null;
  try {
    const obj = JSON.parse(b64UrlToUtf8(code));
    if (!obj || obj.v !== PROTOCOL_VERSION) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * Serialize a camera state. Fields are degrees/meters.
 * Returns null when required fields are missing/non-finite.
 */
export function serializeCamera({ lon, lat, height, heading = 0, pitch = -60 } = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height)) return null;
  return {
    t: 'camera',
    lon: round6(lon),
    lat: round6(lat),
    height: Math.max(0, Math.round(height)),
    heading: round6(heading),
    pitch: round6(pitch),
  };
}

/** Parse/validate an incoming camera message. Null when invalid. */
export function parseCamera(msg) {
  if (!msg || msg.t !== 'camera') return null;
  return serializeCamera(msg);
}

function round6(v) {
  return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : NaN;
}

/** Build a cursor message. Null when invalid. */
export function makeCursor({ lon, lat } = {}) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return { t: 'cursor', lon: round6(lon), lat: round6(lat) };
}

/** Build a pinned-note message. Null when invalid. */
export function makeNote({ id, lon, lat, text, by } = {}) {
  if (typeof id !== 'string' || !id.length) return null;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const clean = String(text ?? '').slice(0, 280);
  if (!clean.length) return null;
  return { t: 'note', id, lon: round6(lon), lat: round6(lat), text: clean, by: String(by ?? 'anon').slice(0, 40) };
}

/** Validate any inbound data-channel message. Returns the message or null. */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return null;
  switch (msg.t) {
    case 'hello':
      return typeof msg.name === 'string' ? { t: 'hello', name: msg.name.slice(0, 40) } : null;
    case 'camera':
      return parseCamera(msg);
    case 'cursor':
      return makeCursor(msg);
    case 'note':
      return makeNote(msg);
    case 'bye':
      return { t: 'bye', name: String(msg.name ?? '').slice(0, 40) };
    default:
      return null;
  }
}

/** Encode a message for the wire (JSON string). */
export function encodeMessage(msg) {
  return JSON.stringify(msg);
}

/** Decode a wire message. Null on failure/invalid. */
export function decodeMessage(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return validateMessage(JSON.parse(raw));
  } catch {
    return null;
  }
}
