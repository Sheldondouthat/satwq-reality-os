# Shared God's eye — integration notes (wave3, part C item 4)

WebRTC multi-cursor globe sessions: two+ viewers share one session with no
server — pure P2P via RTCDataChannel, signaling via manual copy-paste room
codes, free public STUN only, no TURN.

## Honest NAT limitation (stated in the UI, not buried)

Direct P2P works for most home/consumer NATs. When one side sits behind
symmetric NAT (or UDP is blocked), ICE fails and there is no relay to fall
back to — TURN relays cost money and are out of scope. `classifyConnectionFailure()`
diagnoses the failure kind (`symmetric-nat` / `no-srflx` / `relay-failed`)
and the panel says so in plain language, then offers **follow-mode**:
copy-paste camera-state codes (`SATWQ-EYE:…`) that fly the other viewer to
your exact view. Follow-mode needs no network at all.

## 1. `server/providers/local.js` — NO LINES NEEDED

No new `/api/*` routes — there is deliberately no server component.
Exclusion per PAGES_PORT.md.

## 2. `server/pages/registry.mjs` — EXCLUSION NOTE

No server providers added. Client-side only; the Pages Functions bundle is
untouched (no WASM, no node:fs).

## 3. Mount call for `initFrontier` (in `src/frontier/index.js`)

```js
import { initSharedEye } from './wave3/sharedEye/index.js';

// inside initFrontier:
// — Wave3/C4 shared eye: P2P multi-cursor sessions —
attempt('shared-eye', () => {
  const cleanup = initSharedEye({ viewer });
  return () => { if (typeof cleanup === 'function') cleanup(); };
});
```

The viewer handle is used for: reading/broadcasting camera state (2 s
throttle), projecting peer cursors to screen overlays, rendering pinned
notes as Cesium entities, and "follow" fly-to. All Cesium access is guarded
— the panel still works (signaling + follow-mode codes) with `viewer: null`.

## 4. UI strings for theme dictionaries

| Key | Default text |
|---|---|
| `feature.sharedEye` | `Shared view` |
| `ui.sharedEye.open` | `◈ shared eye` |
| `ui.sharedEye.create` | `create session` |
| `ui.sharedEye.join` | `join session` |
| `ui.sharedEye.followMode` | `follow-mode (no P2P needed)` |

## File map

- `protocol.js` — message envelope, room-code codec, validation (pure)
- `net.js` — RTCPeerConnection session, STUN-only ICE, NAT-failure diagnosis
- `follow.js` — follow-mode camera-code export/import, Cesium camera helpers
- `index.js` — `initSharedEye({ viewer })` fail-soft mount + session panel
- `sharedEye.test.mjs` — 14 tests, all passing
