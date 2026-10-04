/**
 * @module indoor/index
 * @description Indoor-twin view shell (feature F11): a full-area 2D canvas
 * for the house-scale twin, sibling to the planetary Cesium globe.
 *
 * Exports:
 *   - mountIndoorView(container, options) -> handle
 *   - unmountIndoorView(handle)
 *   - createViewToggle({ onSwitch }) -> { el, setMode, getMode }
 *
 * Wiring is documented in INTEGRATION.md. This module never touches the
 * globe or HUD files; the host app mounts/unmounts it and flips the toggle.
 */

import {
  createRoom,
  moveRoom,
  resizeRoom,
  roomAt,
  hitHandle,
  deleteRoom,
  nearestWall,
  addDoor,
  renderFloorplan,
  screenToWorld,
  MIN_ROOM_SIZE,
} from './floorplan.js';
import {
  createDevice,
  moveDevice,
  updateDevice,
  deleteDevice,
  deviceAt,
  renderDevices,
  DEVICE_TYPE_IDS,
} from './devices.js';
import { saveIndoorState, loadIndoorState } from './persistence.js';
import { getBluramsStatus } from './bluramsHook.js';

/** Tool modes for the editor toolbar. */
export const INDOOR_TOOLS = Object.freeze([
  'select',
  'room',
  'door',
  'device:camera',
  'device:sensor',
  'device:hub',
  'pan',
]);

const TOOL_LABELS = {
  select: 'Select',
  room: '+ Room',
  door: '+ Door',
  'device:camera': '+ Camera',
  'device:sensor': '+ Sensor',
  'device:hub': '+ Hub',
  pan: 'Pan',
};

function resolveDocument(explicit) {
  if (explicit) return explicit;
  if (typeof globalThis !== 'undefined' && globalThis.document) {
    return globalThis.document;
  }
  return null;
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the indoor view into a container element.
 *
 * @param {HTMLElement} container - Host element; the view fills it.
 * @param {object} [options]
 * @param {Document} [options.document] - DOM document (injectable for tests).
 * @param {Storage} [options.storage] - Persistence backend (injectable).
 * @param {(state) => void} [options.onStateChange] - Called after each mutation.
 * @returns {object} Handle { el, unmount, getState, setTool, getTool, render }.
 */
export function mountIndoorView(container, options = {}) {
  const doc = resolveDocument(options.document);
  if (!doc) throw new Error('mountIndoorView requires a document.');
  if (!container) throw new Error('mountIndoorView requires a container.');

  const storage = options.storage || null;
  const onStateChange = options.onStateChange || (() => {});

  const persisted = loadIndoorState(storage) || {};
  const state = {
    rooms: Array.isArray(persisted.rooms) ? persisted.rooms : [],
    devices: Array.isArray(persisted.devices) ? persisted.devices : [],
    selectedRoomId: null,
    selectedDeviceId: null,
  };
  const view = {
    panX: persisted.view?.panX ?? 40,
    panY: persisted.view?.panY ?? 60,
    zoom: persisted.view?.zoom ?? 1,
  };
  let tool = 'select';
  let drag = null; // active pointer gesture
  const listeners = []; // [target, type, fn, opts] — removed on unmount

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  }

  // ── DOM ──────────────────────────────────────────────────────────────
  const root = el(doc, 'div', 'indoor-view');
  root.tabIndex = 0;
  root.setAttribute('role', 'application');
  root.setAttribute('aria-label', 'Indoor twin floor-plan editor');

  const toolbar = el(doc, 'div', 'indoor-toolbar');
  const toolButtons = new Map();
  for (const id of INDOOR_TOOLS) {
    const btn = el(doc, 'button', 'indoor-tool', TOOL_LABELS[id]);
    btn.type = 'button';
    btn.dataset.tool = id;
    btn.setAttribute('aria-pressed', id === tool ? 'true' : 'false');
    toolbar.appendChild(btn);
    toolButtons.set(id, btn);
  }
  const deleteBtn = el(doc, 'button', 'indoor-tool indoor-danger', 'Delete');
  deleteBtn.type = 'button';
  toolbar.appendChild(deleteBtn);

  const canvas = doc.createElement('canvas');
  canvas.className = 'indoor-canvas';
  // Headless-safe sizing; the host page's CSS makes it fill the area.
  const cssW = container.clientWidth || 800;
  const cssH = container.clientHeight || 600;
  canvas.width = cssW;
  canvas.height = cssH;
  if (canvas.style) {
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.cursor = 'crosshair';
  }

  const status = el(doc, 'div', 'indoor-status');
  const blurams = getBluramsStatus();
  const bluramsTag = el(
    doc,
    'span',
    'indoor-blurams',
    `Blurams: ${blurams.live ? 'LIVE' : 'not connected — hook ready'}`,
  );
  bluramsTag.title = blurams.reason;
  status.appendChild(bluramsTag);
  const statusText = el(doc, 'span', 'indoor-status-text');
  status.appendChild(statusText);

  root.appendChild(toolbar);
  root.appendChild(canvas);
  root.appendChild(status);
  container.appendChild(root);

  // ── Persistence + render ─────────────────────────────────────────────
  function persist() {
    saveIndoorState(
      { rooms: state.rooms, devices: state.devices, view },
      storage,
    );
  }

  function ctx2d() {
    try {
      return typeof canvas.getContext === 'function'
        ? canvas.getContext('2d')
        : null;
    } catch {
      return null;
    }
  }

  function render() {
    const ctx = ctx2d();
    if (!ctx) return; // headless (tests): state still fully functional
    renderFloorplan(
      ctx,
      { rooms: state.rooms, selectedRoomId: state.selectedRoomId },
      view,
      canvas.width,
      canvas.height,
    );
    renderDevices(ctx, state.devices, view, state.selectedDeviceId);
    const zoomPct = Math.round(view.zoom * 100);
    statusText.textContent =
      `${state.rooms.length} room(s) · ${state.devices.length} device(s) · ` +
      `zoom ${zoomPct}% · tool: ${TOOL_LABELS[tool]}`;
  }

  function commit() {
    persist();
    render();
    onStateChange({
      rooms: state.rooms,
      devices: state.devices,
      view: { ...view },
    });
  }

  function setTool(next) {
    if (!INDOOR_TOOLS.includes(next)) return;
    tool = next;
    for (const [id, btn] of toolButtons) {
      btn.setAttribute('aria-pressed', id === tool ? 'true' : 'false');
    }
    render();
  }

  function deleteSelection() {
    let changed = false;
    if (state.selectedDeviceId) {
      state.devices = deleteDevice(state.devices, state.selectedDeviceId);
      state.selectedDeviceId = null;
      changed = true;
    } else if (state.selectedRoomId) {
      state.rooms = deleteRoom(state.rooms, state.selectedRoomId);
      state.selectedRoomId = null;
      changed = true;
    }
    if (changed) commit();
  }

  function promptLabel(current, what) {
    if (typeof globalThis.prompt !== 'function') return current;
    const next = globalThis.prompt(`Label for ${what}:`, current || '');
    return next === null ? current : next;
  }

  // ── Pointer math ─────────────────────────────────────────────────────
  function toWorld(evt) {
    let rect = { left: 0, top: 0 };
    try {
      if (typeof canvas.getBoundingClientRect === 'function') {
        rect = canvas.getBoundingClientRect();
      }
    } catch {
      // headless: origin at 0,0
    }
    const sx = (evt.clientX ?? 0) - rect.left;
    const sy = (evt.clientY ?? 0) - rect.top;
    return screenToWorld(view, sx, sy);
  }

  function selectedRoom() {
    return state.rooms.find((r) => r.id === state.selectedRoomId) || null;
  }

  function replaceRoom(next) {
    state.rooms = state.rooms.map((r) => (r.id === next.id ? next : r));
  }

  function selectedDevice() {
    return state.devices.find((d) => d.id === state.selectedDeviceId) || null;
  }

  function replaceDevice(next) {
    state.devices = state.devices.map((d) => (d.id === next.id ? next : d));
  }

  // ── Gestures ─────────────────────────────────────────────────────────
  function onPointerDown(evt) {
    const p = toWorld(evt);
    if (tool === 'pan' || evt.button === 1) {
      drag = {
        kind: 'pan',
        startX: evt.clientX ?? 0,
        startY: evt.clientY ?? 0,
        panX: view.panX,
        panY: view.panY,
      };
      evt.preventDefault?.();
      return;
    }
    if (tool === 'room') {
      drag = { kind: 'draw-room', anchor: p, current: p };
      state.selectedRoomId = null;
      state.selectedDeviceId = null;
      render();
      return;
    }
    if (tool === 'door') {
      const room = roomAt(state.rooms, p.x, p.y);
      if (room) {
        const wall = nearestWall(room, p.x, p.y);
        if (wall) {
          replaceRoom(addDoor(room, wall.wall, wall.offset));
          state.selectedRoomId = room.id;
          commit();
        }
      }
      return;
    }
    if (tool.startsWith('device:')) {
      const type = tool.slice('device:'.length);
      const device = createDevice({ type, x: p.x, y: p.y });
      state.devices = [...state.devices, device];
      state.selectedDeviceId = device.id;
      state.selectedRoomId = null;
      commit();
      return;
    }
    // select tool
    const devHit = deviceAt(state.devices, p.x, p.y);
    if (devHit) {
      state.selectedDeviceId = devHit.id;
      state.selectedRoomId = null;
      drag = { kind: 'move-device', id: devHit.id, last: p };
      render();
      return;
    }
    const room = selectedRoom();
    if (room) {
      const hit = hitHandle(room, p.x, p.y);
      if (hit === 'move') {
        drag = { kind: 'move-room', id: room.id, last: p };
        state.selectedDeviceId = null;
        render();
        return;
      }
      if (hit) {
        drag = { kind: 'resize-room', id: room.id, handle: hit, last: p };
        state.selectedDeviceId = null;
        render();
        return;
      }
    }
    const hitRoom = roomAt(state.rooms, p.x, p.y);
    state.selectedRoomId = hitRoom ? hitRoom.id : null;
    state.selectedDeviceId = null;
    render();
  }

  function onPointerMove(evt) {
    if (!drag) return;
    const p = toWorld(evt);
    if (drag.kind === 'pan') {
      view.panX = drag.panX + ((evt.clientX ?? 0) - drag.startX);
      view.panY = drag.panY + ((evt.clientY ?? 0) - drag.startY);
      render();
      return;
    }
    if (drag.kind === 'draw-room') {
      drag.current = p;
      // Live preview: render a transient room without committing.
      const preview = createRoom({
        x: drag.anchor.x,
        y: drag.anchor.y,
        w: p.x - drag.anchor.x,
        h: p.y - drag.anchor.y,
      });
      const ctx = ctx2d();
      if (ctx) {
        renderFloorplan(
          ctx,
          { rooms: [...state.rooms, preview], selectedRoomId: preview.id },
          view,
          canvas.width,
          canvas.height,
        );
        renderDevices(ctx, state.devices, view, state.selectedDeviceId);
      }
      return;
    }
    const dx = p.x - drag.last.x;
    const dy = p.y - drag.last.y;
    drag.last = p;
    if (drag.kind === 'move-room') {
      const room = state.rooms.find((r) => r.id === drag.id);
      if (room) replaceRoom(moveRoom(room, dx, dy));
      render();
    } else if (drag.kind === 'resize-room') {
      const room = state.rooms.find((r) => r.id === drag.id);
      if (room) replaceRoom(resizeRoom(room, drag.handle, dx, dy));
      render();
    } else if (drag.kind === 'move-device') {
      const device = state.devices.find((d) => d.id === drag.id);
      if (device) replaceDevice(moveDevice(device, dx, dy));
      render();
    }
  }

  function onPointerUp(evt) {
    if (drag?.kind === 'draw-room') {
      const p = toWorld(evt);
      const room = createRoom({
        x: drag.anchor.x,
        y: drag.anchor.y,
        w: p.x - drag.anchor.x,
        h: p.y - drag.anchor.y,
      });
      if (room.w >= MIN_ROOM_SIZE && room.h >= MIN_ROOM_SIZE) {
        state.rooms = [...state.rooms, room];
        state.selectedRoomId = room.id;
        commit();
      } else {
        render();
      }
    } else if (drag && drag.kind !== 'pan') {
      commit(); // persist after move/resize gestures
    } else if (drag?.kind === 'pan') {
      persist();
    }
    drag = null;
  }

  function onWheel(evt) {
    evt.preventDefault?.();
    const factor = evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextZoom = Math.min(4, Math.max(0.25, view.zoom * factor));
    // Zoom around the cursor: keep the world point under the cursor fixed.
    let rect = { left: 0, top: 0 };
    try {
      if (typeof canvas.getBoundingClientRect === 'function')
        rect = canvas.getBoundingClientRect();
    } catch {
      /* headless */
    }
    const sx = (evt.clientX ?? 0) - rect.left;
    const sy = (evt.clientY ?? 0) - rect.top;
    const wx = (sx - view.panX) / view.zoom;
    const wy = (sy - view.panY) / view.zoom;
    view.zoom = nextZoom;
    view.panX = sx - wx * nextZoom;
    view.panY = sy - wy * nextZoom;
    render();
  }

  function onDblClick(evt) {
    const p = toWorld(evt);
    const devHit = deviceAt(state.devices, p.x, p.y);
    if (devHit) {
      const label = promptLabel(devHit.label, 'device');
      let notes = devHit.notes;
      if (typeof globalThis.prompt === 'function') {
        const n = globalThis.prompt('Notes for device:', devHit.notes || '');
        if (n !== null) notes = n;
      }
      replaceDevice(updateDevice(devHit, { label, notes }));
      commit();
      return;
    }
    const room = roomAt(state.rooms, p.x, p.y);
    if (room) {
      const label = promptLabel(room.label, 'room');
      replaceRoom({ ...room, label });
      state.selectedRoomId = room.id;
      commit();
    }
  }

  function onKeyDown(evt) {
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      // Don't eat keystrokes from inputs (there are none yet, but be safe).
      const tag = evt.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      deleteSelection();
      evt.preventDefault?.();
    } else if (evt.key === 'Escape') {
      state.selectedRoomId = null;
      state.selectedDeviceId = null;
      render();
    }
  }

  for (const [id, btn] of toolButtons) {
    on(btn, 'click', () => setTool(id));
  }
  on(deleteBtn, 'click', deleteSelection);
  on(canvas, 'pointerdown', onPointerDown);
  on(canvas, 'pointermove', onPointerMove);
  on(canvas, 'pointerup', onPointerUp);
  on(canvas, 'wheel', onWheel, { passive: false });
  on(canvas, 'dblclick', onDblClick);
  on(root, 'keydown', onKeyDown);

  render();

  const handle = {
    el: root,
    canvas,
    getState: () => ({
      rooms: state.rooms,
      devices: state.devices,
      view: { ...view },
      selectedRoomId: state.selectedRoomId,
      selectedDeviceId: state.selectedDeviceId,
    }),
    setTool,
    getTool: () => tool,
    render,
    /** Number of listeners currently tracked (for leak tests). */
    listenerCount: () => listeners.length,
    unmount: () => unmountIndoorView(handle),
  };
  // Back-reference so unmountIndoorView(handle) can find internals.
  handle[UNMOUNT_KEY] = { root, container, listeners };
  return handle;
}

const UNMOUNT_KEY = Symbol.for('satwq.indoor.unmount');

/**
 * Unmount a view previously created by mountIndoorView. Removes every
 * listener registered at mount time, detaches the DOM, and clears the
 * internal registry so a second unmount is a safe no-op.
 *
 * @param {object} handle - Handle returned by mountIndoorView.
 */
export function unmountIndoorView(handle) {
  if (!handle) return;
  const internals = handle[UNMOUNT_KEY];
  if (!internals || internals.done) return; // idempotent
  internals.done = true;
  for (const [target, type, fn, opts] of internals.listeners) {
    try {
      target.removeEventListener(type, fn, opts);
    } catch {
      // Best effort: a half-torn-down DOM must not throw.
    }
  }
  internals.listeners.length = 0;
  try {
    internals.root.remove();
  } catch {
    try {
      internals.container.removeChild(internals.root);
    } catch {
      // Already detached.
    }
  }
}

/**
 * Create a GLOBE / INDOOR segmented switch control matching the app's
 * chip-group visual language (aria-pressed segmented buttons).
 *
 * @param {object} [options]
 * @param {(mode: 'globe'|'indoor') => void} [options.onSwitch] - Called on change.
 * @param {Document} [options.document] - DOM document (injectable for tests).
 * @param {'globe'|'indoor'} [options.initial='globe']
 * @returns {{el: HTMLElement, setMode: (m) => void, getMode: () => string}}
 */
export function createViewToggle({
  onSwitch = () => {},
  document: explicitDoc,
  initial = 'globe',
} = {}) {
  const doc = resolveDocument(explicitDoc);
  if (!doc) throw new Error('createViewToggle requires a document.');
  let mode = initial === 'indoor' ? 'indoor' : 'globe';

  const wrap = el(doc, 'div', 'indoor-view-toggle');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'View mode');

  const buttons = {};
  for (const m of ['globe', 'indoor']) {
    const btn = el(doc, 'button', 'indoor-view-toggle-btn', m.toUpperCase());
    btn.type = 'button';
    btn.dataset.viewMode = m;
    btn.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    btn.addEventListener('click', () => setMode(m));
    buttons[m] = btn;
    wrap.appendChild(btn);
  }

  function setMode(next) {
    if (next !== 'globe' && next !== 'indoor') return;
    if (next === mode) return;
    mode = next;
    for (const m of ['globe', 'indoor']) {
      buttons[m].setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
    onSwitch(mode);
  }

  return { el: wrap, setMode, getMode: () => mode };
}
