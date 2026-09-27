/**
 * Shared God's eye — WebRTC peer session.
 *
 * Pure P2P: RTCPeerConnection + one RTCDataChannel (`satwq-eye`), STUN only
 * (free public Google STUN servers), NO TURN. This is the honest trade:
 * direct connections work for most home NATs, but symmetric NAT on either
 * side will fail and there is no relay to fall back to — paid TURN relays
 * are out of scope (NOTHING paid, ever). When the connection fails, the UI
 * says so plainly and offers follow-mode (copy-paste camera state).
 *
 * Signaling is manual copy-paste:
 *   host:  createOffer() → show code → paste guest's answer code → connect
 *   guest: paste host code → createAnswer() → show code → send back to host
 */

/** Free public STUN servers (no key, no account). */
export const STUN_SERVERS = Object.freeze([
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]);

/**
 * Classify a failed connection for an honest user-facing explanation.
 * Pure — takes observed ICE/connection facts, returns a diagnosis.
 *
 * @param {object} facts — { connectionState, iceConnectionState,
 *   hadSrflxCandidate, hadRelayCandidate, iceGatheringComplete }
 */
export function classifyConnectionFailure(facts = {}) {
  const { connectionState, iceConnectionState, hadSrflxCandidate, hadRelayCandidate } = facts;
  const failed = connectionState === 'failed' || iceConnectionState === 'failed' || iceConnectionState === 'disconnected';
  if (!failed) return { ok: true, kind: 'not-failed' };
  if (hadRelayCandidate) {
    return {
      ok: false,
      kind: 'relay-failed',
      message:
        'Connection failed even with a relay candidate — likely a firewall blocking UDP entirely.',
    };
  }
  if (!hadSrflxCandidate) {
    return {
      ok: false,
      kind: 'no-srflx',
      message:
        'No public address discovered (STUN unreachable or UDP blocked). Check that UDP is allowed outbound.',
    };
  }
  return {
    ok: false,
    kind: 'symmetric-nat',
    message:
      'Both sides found public addresses but could not connect — likely symmetric NAT on at least one side. ' +
      'Without a TURN relay (none configured — relays cost money) this pair cannot connect directly. ' +
      'Use follow-mode below: paste camera states back and forth instead.',
  };
}

import { encodeMessage, decodeMessage } from './protocol.js';

function rtcAvailable() {
  try {
    return typeof RTCPeerConnection !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Create a peer session.
 *
 * @param {object} opts — { onMessage(msg, peerId), onPeerChange(peers),
 *   onStateChange(state), name }
 * @returns session handle with createOffer/createAnswer/acceptAnswer/send/close
 */
export function createPeerSession({ onMessage, onPeerChange, onStateChange, name = 'anon' } = {}) {
  if (!rtcAvailable()) {
    throw new Error('WebRTC unavailable in this browser');
  }
  const peers = new Map(); // peerId -> { pc, channel, name, camera, cursor, connected }
  let peerSeq = 0;
  const emitPeers = () => {
    try {
      if (onPeerChange) onPeerChange([...peers.values()].map((p) => peerView(p)));
    } catch {
      /* ignore */
    }
  };
  const peerView = (p) => ({
    id: p.id,
    name: p.name,
    connected: p.connected,
    camera: p.camera,
    cursor: p.cursor,
  });

  const wireChannel = (peer, channel) => {
    peer.channel = channel;
    channel.onopen = () => {
      peer.connected = true;
      emitPeers();
      sendTo(peer, { t: 'hello', name });
    };
    channel.onclose = () => {
      peer.connected = false;
      emitPeers();
    };
    channel.onmessage = (ev) => {
      const msg = decodeMessage(typeof ev.data === 'string' ? ev.data : '');
      if (!msg) return;
      if (msg.t === 'hello') peer.name = msg.name || peer.name;
      else if (msg.t === 'camera') peer.camera = msg;
      else if (msg.t === 'cursor') peer.cursor = msg;
      else if (msg.t === 'bye') {
        removePeer(peer.id);
        return;
      }
      emitPeers();
      try {
        if (onMessage) onMessage(msg, peer.id);
      } catch {
        /* ignore */
      }
    };
  };

  const trackIce = (peer, pc) => {
    peer.ice = { srflx: false, relay: false };
    pc.addEventListener('icecandidate', (ev) => {
      const cand = ev.candidate?.candidate || '';
      if (cand.includes('typ srflx')) peer.ice.srflx = true;
      if (cand.includes('typ relay')) peer.ice.relay = true;
    });
    pc.addEventListener('connectionstatechange', () => {
      try {
        if (onStateChange) onStateChange({ peerId: peer.id, connectionState: pc.connectionState });
      } catch {
        /* ignore */
      }
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        peer.diagnosis = classifyConnectionFailure({
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
          hadSrflxCandidate: peer.ice.srflx,
          hadRelayCandidate: peer.ice.relay,
        });
        try {
          if (onStateChange) onStateChange({ peerId: peer.id, diagnosis: peer.diagnosis });
        } catch {
          /* ignore */
        }
      }
    });
  };

  const newPeer = (pc) => {
    peerSeq += 1;
    const peer = {
      id: `peer-${peerSeq}`,
      pc,
      channel: null,
      name: `peer-${peerSeq}`,
      camera: null,
      cursor: null,
      connected: false,
      ice: { srflx: false, relay: false },
      diagnosis: null,
    };
    peers.set(peer.id, peer);
    trackIce(peer, pc);
    return peer;
  };

  const removePeer = (id) => {
    const peer = peers.get(id);
    if (!peer) return;
    try {
      peer.channel?.close();
    } catch {
      /* ignore */
    }
    try {
      peer.pc.close();
    } catch {
      /* ignore */
    }
    peers.delete(id);
    emitPeers();
  };

  const sendTo = (peer, msg) => {
    try {
      if (peer.channel && peer.channel.readyState === 'open') {
        peer.channel.send(encodeMessage(msg));
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  };

  return {
    get peerCount() {
      return peers.size;
    },
    get peers() {
      return [...peers.values()].map(peerView);
    },

    /** Host: create an offer; returns the room code to copy-paste to the guest. */
    async createOffer() {
      const { encodeRoomCode } = await import('./protocol.js');
      const pc = new RTCPeerConnection({ iceServers: [...STUN_SERVERS] });
      const peer = newPeer(pc);
      const channel = pc.createDataChannel('satwq-eye', { ordered: true });
      wireChannel(peer, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);
      peer.pendingId = peer.id;
      return { peerId: peer.id, code: encodeRoomCode({ sdp: pc.localDescription }) };
    },

    /** Guest: paste the host's code; returns your answer code to send back. */
    async createAnswer(hostCode) {
      const { encodeRoomCode, decodeRoomCode } = await import('./protocol.js');
      const payload = decodeRoomCode(hostCode);
      if (!payload?.sdp) throw new Error('invalid room code');
      const pc = new RTCPeerConnection({ iceServers: [...STUN_SERVERS] });
      const peer = newPeer(pc);
      pc.ondatachannel = (ev) => wireChannel(peer, ev.channel);
      await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitForIceGathering(pc);
      return { peerId: peer.id, code: encodeRoomCode({ sdp: pc.localDescription }) };
    },

    /** Host: paste the guest's answer code to complete the handshake. */
    async acceptAnswer(peerId, answerCode) {
      const { decodeRoomCode } = await import('./protocol.js');
      const payload = decodeRoomCode(answerCode);
      if (!payload?.sdp) throw new Error('invalid answer code');
      const peer = peers.get(peerId);
      if (!peer) throw new Error('unknown peer');
      await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      return peerView(peer);
    },

    /** Broadcast a protocol message to all connected peers. */
    broadcast(msg) {
      let sent = 0;
      for (const peer of peers.values()) {
        if (sendTo(peer, msg)) sent += 1;
      }
      return sent;
    },

    removePeer,

    close() {
      for (const id of [...peers.keys()]) removePeer(id);
    },
  };
}

/** Wait for ICE gathering to complete (or time out after 8 s). */
function waitForIceGathering(pc, timeoutMs = 8000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}
