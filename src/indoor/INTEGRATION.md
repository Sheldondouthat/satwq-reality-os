# F11 — Indoor Twin: integration guide

The indoor twin (`src/indoor/`) is a self-contained view shell: a 2D
room-scale canvas that lives **alongside** the Cesium globe, never inside it.
No existing files were modified to build it. Wiring it into the app is three
small, reversible steps below.

## Files

| File | Role |
|---|---|
| `src/indoor/index.js` | `mountIndoorView(container, options)` / `unmountIndoorView(handle)` / `createViewToggle({onSwitch})` + editor interactions |
| `src/indoor/floorplan.js` | Room model + canvas renderer (add/move/resize/label/delete rooms, doors as wall gaps). Pure geometry — no DOM |
| `src/indoor/devices.js` | Placeable camera/sensor/hub markers (label + notes). Pure model |
| `src/indoor/persistence.js` | localStorage save/load (`satwq.indoor.v1`), corrupt-record safe |
| `src/indoor/bluramsHook.js` | Documented `attachFrameSource(canvasEl, {getFrame})` hook + honest reachability notes |
| `src/indoor/*.test.mjs` | 36 tests: geometry, markers, persistence round-trip, mount/unmount listener cleanup |

## Step 1 — view host + toggle (in the app boot, e.g. near viewer creation)

```js
import { mountIndoorView, unmountIndoorView, createViewToggle } from './indoor/index.js';

// `globeContainer` is the element the Cesium Viewer was constructed with
// (see src/app/viewer.js -> createApplicationViewer({ container })).
const indoorHost = document.createElement('div');
indoorHost.id = 'indoor-host';
indoorHost.hidden = true;
globeContainer.parentElement.appendChild(indoorHost);

let indoorHandle = null;
const toggle = createViewToggle({
  onSwitch: (mode) => {
    const indoor = mode === 'indoor';
    if (indoor && !indoorHandle) {
      indoorHandle = mountIndoorView(indoorHost);
    }
    if (!indoor && indoorHandle) {
      unmountIndoorView(indoorHandle);
      indoorHandle = null;
    }
    globeContainer.hidden = indoor;
    indoorHost.hidden = !indoor;
  },
});

// Place the toggle in the HUD chrome, e.g. next to the view/layer controls:
// hudTopBar.appendChild(toggle.el);
```

Notes:

- `mountIndoorView` restores rooms/devices/view from localStorage automatically.
- `unmountIndoorView` removes **every** listener registered at mount time
  (tracked registry; covered by the leak test) and detaches the DOM. Calling
  it twice is a safe no-op.
- `createViewToggle` matches the app's segmented chip language
  (`aria-pressed`, `role="group"`). `toggle.setMode('globe' | 'indoor')` and
  `toggle.getMode()` are available for programmatic switching (e.g. voice
  commands, keyboard shortcut).

## Step 2 — styling (add to style.css or a view stylesheet)

```css
#indoor-host { position: absolute; inset: 0; }
.indoor-view { position: absolute; inset: 0; display: flex; flex-direction: column;
  background: #020a0e; outline: none; }
.indoor-canvas { flex: 1; cursor: crosshair; }
.indoor-toolbar { display: flex; gap: 6px; padding: 8px;
  background: rgba(2, 12, 16, 0.9); border-bottom: 1px solid rgba(0,255,255,0.15); }
.indoor-tool { font: 12px system-ui, sans-serif; color: rgba(0,255,255,0.8);
  background: rgba(0,255,255,0.06); border: 1px solid rgba(0,255,255,0.25);
  border-radius: 4px; padding: 6px 10px; cursor: pointer; }
.indoor-tool[aria-pressed="true"] { background: rgba(0,255,255,0.22); color: #eaffff; }
.indoor-danger { color: rgba(255,120,120,0.9); border-color: rgba(255,120,120,0.4); }
.indoor-status { display: flex; gap: 12px; padding: 6px 10px;
  font: 11px system-ui, sans-serif; color: rgba(0,255,255,0.6);
  border-top: 1px solid rgba(0,255,255,0.15); }
.indoor-view-toggle { display: inline-flex; border: 1px solid rgba(0,255,255,0.25);
  border-radius: 4px; overflow: hidden; }
.indoor-view-toggle-btn { font: 11px system-ui, sans-serif; letter-spacing: 1px;
  color: rgba(0,255,255,0.7); background: transparent; border: 0;
  padding: 6px 12px; cursor: pointer; }
.indoor-view-toggle-btn[aria-pressed="true"] { background: rgba(0,255,255,0.22); color: #eaffff; }
```

## Step 3 — editor interactions (built in, no wiring needed)

| Gesture | Action |
|---|---|
| Toolbar → `+ Room`, then click-drag | Draw a room rectangle (drags under 24px are discarded) |
| `Select` → drag room interior | Move room |
| `Select` → drag a corner/edge handle | Resize room (clamped to 24px min) |
| `Select` → click room/device, then `Delete` / `Backspace` | Delete selection (`Esc` deselects) |
| Double-click room / device | Prompt to edit label (devices also get a notes prompt) |
| `+ Door`, then click near a wall | Add a door: wall gap + swing marker at the nearest wall |
| `+ Camera` / `+ Sensor` / `+ Hub`, then click | Place a labeled device marker; drag to move in `Select` mode |
| Mouse wheel | Zoom around cursor (25%–400%) |
| `Pan` tool (or middle-drag) | Pan the plan |

Every mutation autosaves to localStorage (`satwq.indoor.v1`); the next mount
restores rooms, doors, devices, labels, notes, pan, and zoom.

## Blurams camera hook (honest v1)

There is **no browser-reachable Blurams camera API** — the camera is
app/cloud-only. Camera markers are user-mapped placeholders (label + notes),
and the status bar says so: `Blurams: not connected — hook ready` with the
reason in the tooltip.

When a frame source exists, attach it per marker:

```js
import { attachFrameSource, getBluramsStatus } from './indoor/bluramsHook.js';

const status = getBluramsStatus(); // { live: false, reason, paths: [...] }
const thumb = document.createElement('canvas'); // marker thumbnail
const handle = attachFrameSource(thumb, {
  getFrame: async () => fetch('http://<lan-bridge>/cam/porch/frame.jpg').then(r => r.blob()),
  intervalMs: 5000,
  onError: (err) => console.warn('blurams frame failed', err),
});
// handle.refresh() forces a frame; handle.detach() stops polling.
// Polling auto-detaches after 5 consecutive failures.
```

Realistic upgrade paths (documented in `bluramsHook.js`):

1. **Local bridge app** (recommended): a user-run service on the home LAN
   re-serves snapshots as MJPEG/JPEG; credentials stay in the bridge, never in
   this repo.
2. **Official web portal** (`client.blurams.com`) via the user's
   authenticated session (Secure Vault flow); verify the portal's CORS/frame
   policy before promising embedding.

## Verification

```bash
node --check src/indoor/index.js src/indoor/floorplan.js src/indoor/devices.js \
  src/indoor/persistence.js src/indoor/bluramsHook.js
node --test src/indoor/*.test.mjs   # 36 tests, 0 failures (2026-09-26)
```

No new npm dependencies. No keys. Client-side only. No fake live data —
every element is user-mapped or explicitly a hook.

## Deliberately out of v1 scope

- Door deletion / door width editing (add-only for now).
- Multi-room select, copy/paste, undo.
- Wall-thickness / non-rectangular rooms.
- Any live camera feed (blocked on a real frame source; see hook above).
