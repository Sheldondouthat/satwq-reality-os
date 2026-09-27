/**
 * @module indoor/devices
 * @description Placeable device markers for the indoor twin: cameras, sensors,
 * hubs. Each marker is user-mapped (label + freeform notes) — nothing here is
 * a live data source; the Blurams camera bridge is a documented hook in
 * bluramsHook.js. Pure model functions; rendering takes a duck-typed 2D ctx.
 */

/** Device type catalog: glyph drawn on canvas + legend color. */
export const DEVICE_TYPES = Object.freeze({
  camera: { label: 'Camera', color: 'rgba(255, 120, 120, 0.95)', glyph: 'C' },
  sensor: { label: 'Sensor', color: 'rgba(120, 200, 255, 0.95)', glyph: 'S' },
  hub: { label: 'Hub', color: 'rgba(150, 255, 150, 0.95)', glyph: 'H' },
});

export const DEVICE_TYPE_IDS = Object.freeze(Object.keys(DEVICE_TYPES));

/** Marker hit radius in plan pixels. */
export const DEVICE_HIT_RADIUS = 12;

let deviceSequence = 0;

/**
 * Create a device marker.
 * @param {object} opts - {type, x, y, label, notes}.
 * @returns {object} Device {id, type, x, y, label, notes}.
 */
export function createDevice({ type, x, y, label = '', notes = '' }) {
  if (!DEVICE_TYPES[type]) throw new Error(`Unknown device type: ${type}`);
  return {
    id: `dev-${++deviceSequence}-${Date.now().toString(36)}`,
    type,
    x,
    y,
    label: label || DEVICE_TYPES[type].label,
    notes,
  };
}

/** Translate a device. @returns {object} New device. */
export function moveDevice(device, dx, dy) {
  return { ...device, x: device.x + dx, y: device.y + dy };
}

/** Update label/notes. @returns {object} New device. */
export function updateDevice(device, { label, notes }) {
  return {
    ...device,
    label: label === undefined ? device.label : label,
    notes: notes === undefined ? device.notes : notes,
  };
}

/** Remove a device by id. @returns {object[]} New array. */
export function deleteDevice(devices, id) {
  return devices.filter((device) => device.id !== id);
}

/**
 * Topmost device marker within hit radius of a point.
 * @returns {object|null}
 */
export function deviceAt(devices, px, py, radius = DEVICE_HIT_RADIUS) {
  for (let i = devices.length - 1; i >= 0; i--) {
    const d = devices[i];
    const dist = Math.hypot(d.x - px, d.y - py);
    if (dist <= radius) return d;
  }
  return null;
}

/**
 * Render device markers.
 * @param {CanvasRenderingContext2D} ctx - Duck-typed 2D context.
 * @param {object[]} devices - Device records.
 * @param {object} view - {panX, panY, zoom}.
 * @param {string|null} selectedId - Selected device id for highlight.
 */
export function renderDevices(ctx, devices, view, selectedId = null) {
  if (!ctx) return;
  ctx.save();
  for (const device of devices) {
    const meta = DEVICE_TYPES[device.type] || DEVICE_TYPES.sensor;
    const sx = device.x * view.zoom + view.panX;
    const sy = device.y * view.zoom + view.panY;
    const r = Math.max(10 * view.zoom, 6);
    const selected = device.id === selectedId;
    // Marker disc.
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(2, 10, 14, 0.9)';
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeStyle = meta.color;
    ctx.stroke();
    // Glyph.
    ctx.fillStyle = meta.color;
    ctx.font = `${Math.max(10, r)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.glyph, sx, sy + 1);
    // Label tag.
    if (device.label) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(220, 255, 255, 0.9)';
      ctx.fillText(device.label, sx + r + 5, sy + 4);
    }
    if (selected) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(sx, sy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}
