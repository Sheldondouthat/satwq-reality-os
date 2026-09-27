/**
 * Shared God's eye tests — REAL assertions (node:test).
 * Protocol round-trips, room codes, camera/cursor/note validation,
 * NAT-failure classification, follow-mode export/import.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNEL_LABEL,
  PROTOCOL_VERSION,
  encodeRoomCode,
  decodeRoomCode,
  serializeCamera,
  parseCamera,
  makeCursor,
  makeNote,
  validateMessage,
  encodeMessage,
  decodeMessage,
} from './protocol.js';
import { classifyConnectionFailure, STUN_SERVERS } from './net.js';
import { exportCameraState, importCameraState, readViewerCamera } from './follow.js';

describe('protocol', () => {
  it('channel label and version are stable', () => {
    assert.equal(CHANNEL_LABEL, 'satwq-eye');
    assert.equal(PROTOCOL_VERSION, 1);
  });

  it('room codes round-trip and reject garbage', () => {
    const payload = { sdp: { type: 'offer', sdp: 'v=0\r\n...' } };
    const code = encodeRoomCode(payload);
    assert.ok(typeof code === 'string' && code.length > 0);
    assert.ok(!/[+/=]/.test(code), 'base64url, no padding');
    const back = decodeRoomCode(code);
    assert.equal(back.v, 1);
    assert.deepEqual(back.sdp, payload.sdp);
    assert.equal(decodeRoomCode('!!!not-a-code!!!'), null);
    assert.equal(decodeRoomCode(''), null);
    assert.equal(decodeRoomCode(null), null);
    // wrong version rejected
    const tampered = encodeRoomCode({ v: 999, x: 1 });
    assert.equal(decodeRoomCode(tampered), null);
  });

  it('serializeCamera/parseCamera validate fields', () => {
    const cam = serializeCamera({ lon: -80.123456789, lat: 37.1, height: 2000000, heading: 10, pitch: -60 });
    assert.ok(cam);
    assert.equal(cam.t, 'camera');
    assert.equal(cam.lon, -80.123457, 'rounded to 6dp');
    assert.equal(serializeCamera({ lon: 0, lat: 0 }), null, 'height required');
    assert.equal(serializeCamera({ lon: NaN, lat: 0, height: 1 }), null);
    assert.deepEqual(parseCamera(cam), cam);
    assert.equal(parseCamera({ t: 'cursor' }), null);
  });

  it('makeCursor and makeNote validate', () => {
    assert.deepEqual(makeCursor({ lon: 10, lat: 20 }), { t: 'cursor', lon: 10, lat: 20 });
    assert.equal(makeCursor({ lon: 10 }), null);
    const note = makeNote({ id: 'n1', lon: 10, lat: 20, text: 'look here', by: 'sheldon' });
    assert.equal(note.t, 'note');
    assert.equal(note.by, 'sheldon');
    assert.equal(makeNote({ id: 'n1', lon: 10, lat: 20, text: '' }), null, 'empty text rejected');
    assert.equal(makeNote({ id: '', lon: 10, lat: 20, text: 'x' }), null, 'empty id rejected');
    const long = makeNote({ id: 'n2', lon: 10, lat: 20, text: 'x'.repeat(500) });
    assert.equal(long.text.length, 280, 'text capped');
  });

  it('validateMessage accepts known types, rejects the rest', () => {
    assert.deepEqual(validateMessage({ t: 'hello', name: 'ash' }), { t: 'hello', name: 'ash' });
    assert.equal(validateMessage({ t: 'hello' }), null);
    assert.ok(validateMessage({ t: 'camera', lon: 1, lat: 2, height: 3 }));
    assert.ok(validateMessage({ t: 'cursor', lon: 1, lat: 2 }));
    assert.ok(validateMessage({ t: 'bye', name: 'x' }));
    assert.equal(validateMessage({ t: 'teleport', x: 1 }), null);
    assert.equal(validateMessage('nope'), null);
    assert.equal(validateMessage(null), null);
  });

  it('encode/decodeMessage round-trip over the wire format', () => {
    const msg = makeCursor({ lon: -80.5, lat: 37.2 });
    const back = decodeMessage(encodeMessage(msg));
    assert.deepEqual(back, msg);
    assert.equal(decodeMessage('{broken'), null);
    assert.equal(decodeMessage(42), null);
  });
});

describe('classifyConnectionFailure', () => {
  it('reports not-failed when nothing failed', () => {
    assert.deepEqual(classifyConnectionFailure({ connectionState: 'connected' }).ok, true);
    assert.deepEqual(classifyConnectionFailure({}).ok, true);
  });

  it('detects symmetric-NAT signature honestly', () => {
    const d = classifyConnectionFailure({
      connectionState: 'failed',
      hadSrflxCandidate: true,
      hadRelayCandidate: false,
    });
    assert.equal(d.ok, false);
    assert.equal(d.kind, 'symmetric-nat');
    assert.ok(d.message.includes('TURN'), 'message names the missing TURN relay');
    assert.ok(d.message.includes('follow-mode'), 'message offers the fallback');
  });

  it('distinguishes no-STUN from relay failure', () => {
    const noSrflx = classifyConnectionFailure({ iceConnectionState: 'failed', hadSrflxCandidate: false });
    assert.equal(noSrflx.kind, 'no-srflx');
    const relay = classifyConnectionFailure({ connectionState: 'failed', hadSrflxCandidate: true, hadRelayCandidate: true });
    assert.equal(relay.kind, 'relay-failed');
  });

  it('STUN list is keyless public servers', () => {
    assert.ok(STUN_SERVERS.length >= 1);
    for (const s of STUN_SERVERS) {
      assert.ok(String(s.urls).startsWith('stun:'), 'STUN only, no TURN');
    }
  });
});

describe('follow-mode', () => {
  it('export/import camera codes round-trip', () => {
    const cam = { lon: -80.12345, lat: 37.23456, height: 1500000, heading: 45, pitch: -55 };
    const code = exportCameraState(cam);
    assert.ok(code.startsWith('SATWQ-EYE:'));
    const back = importCameraState(code);
    assert.ok(back);
    assert.ok(Math.abs(back.lon - cam.lon) < 1e-4);
    assert.ok(Math.abs(back.lat - cam.lat) < 1e-4);
    assert.equal(back.height, cam.height);
  });

  it('import rejects garbage and out-of-range values', () => {
    assert.equal(importCameraState('hello world'), null);
    assert.equal(importCameraState(''), null);
    assert.equal(importCameraState(null), null);
    assert.equal(importCameraState('SATWQ-EYE:!!!'), null);
  });

  it('export refuses incomplete cameras', () => {
    assert.equal(exportCameraState(null), null);
    assert.equal(exportCameraState({ lon: 0, lat: 0 }), null);
  });

  it('readViewerCamera reads a Cesium-like viewer', () => {
    const viewer = {
      camera: {
        positionCartographic: { longitude: -1.4, latitude: 0.65, height: 2000000 },
        heading: 0.5,
        pitch: -1.0,
      },
    };
    const cam = readViewerCamera(viewer);
    assert.ok(cam);
    assert.ok(Math.abs(cam.lon - (-1.4 * 180) / Math.PI) < 1e-9);
    assert.equal(readViewerCamera(null), null);
    assert.equal(readViewerCamera({}), null);
  });
});
